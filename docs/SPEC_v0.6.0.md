# ТЗ v0.6.0 — «PW2 Presets Addon»

Статус: draft для обсуждения. Кодирование не начато — сначала фиксируем архитектуру.
Дата: 2026-07-17.

## 0. Итог исследования (основание для ТЗ)

Ключевой пивот: старый watchdog-переключатель (chooser daemon) избыточен. PassWall2 (далее PW2)
уже нативно умеет то, что мы пытались реализовать поверх него: авто-выбор лучшей ноды
(Xray Balancing / sing-box URLTest), health-check, fallback. Наш код должен стать тонкой
надстройкой — генератором пресетов конфигурации + лёгким наблюдателем, а не параллельным
движком управления трафиком.

### 0.1 Killswitch: что подтверждено кодом PW2 (не гипотеза, а факт из исходников)

Прочитаны `app.sh`, `nftables.sh`, `monitor.sh` из
[Openwrt-Passwall/openwrt-passwall2](https://github.com/Openwrt-Passwall/openwrt-passwall2)
и issue [#796 "Kill Switch"](https://github.com/xiaorouji/openwrt-passwall2/issues/796).

- Функция `del_firewall_rule()` (полностью снимает все `PSW2_*` nft-правила/цепочки/сеты) —
  вызывается **только** из `stop()`. Никакого вызова из live health-check или при падении
  Xray в файле нет.
- Значит: **если Xray/sing-box падает или виснет, пока сам сервис PW2 не останавливался** —
  nft-правила TPROXY/REDIRECT остаются на месте, LAN-трафик продолжает редиректиться на
  (мёртвый) локальный порт и просто рвётся/зависает. Это ровно то, что мы видели в
  WAN Monitor логе: полный обрыв интернета, но никогда — посторонний IP.
- DNS устроен тем же образом: `PSW2_DNS`-цепочка безусловно редиректит UDP/TCP:53 от LAN на
  `dns_redirect_port` (`nft ... redirect to :$dns_redirect_port`). Никакого explicit
  ACCEPT/direct-fallback правила на случай недоступности порта в коде нет. Значит DNS **тоже
  fail-closed по построению** — при падении процесса DNS-запросы редиректятся в никуда, а не
  утекают на реальный upstream DNS.
- **Реальная дырка — не падение Xray, а цикл `stop()` → `start()`** (ручной restart,
  "Save & Apply" многих настроек в LuCI, перезагрузка роутера до инициализации PW2).
  `del_firewall_rule()` полностью снимает защиту, и до завершения `start()` у LAN есть
  прямой путь наружу. Именно эту дырку просил закрыть автор issue #796 ("сохранять
  nftables-правила при смене конфигурации, чтобы интернета не было, если xray не подключен") —
  **фича закрыта апстримом как `not planned` (22.04.2025)**, то есть в самом PW2 её не будет.
- `monitor.sh` — собственный watchdog процессов PW2: раз в ~58 сек (+до 6 сек lock-задержка)
  проверяет через `pgrep -f`, жив ли зарегистрированный процесс, и перезапускает через
  `nohup` (без `procd respawn`). Работает только если
  `passwall2.@global[0].enabled=1` **и** `passwall2.@global_delay[0].start_daemon=1`.
  `pgrep` детектит только "процесса нет", не "процесс жив, но подвис (deadlock)".

**Вывод:** нативный killswitch у PW2 не нужен для сценария "Xray упал во время работы" —
там и так fail-closed. Нужен (если решим строить) **точечный "guard" только на окно
stop→start и на boot-до-инициализации** — принципиально более лёгкая задача, чем 24/7
параллельная nft DROP-таблица (которая, вероятно, и есть причина P18 — просадки throughput).

### 0.2 Открытые пункты, требующие диагностики с роутера (сам не могу проверить — нет доступа)

Прежде чем куда-то кодить guard/killswitch v2 — нужны факты, а не гадание:

1. Подтвердить/опровергнуть OOM-гипотезу по инциденту 05:57–06:01 17.07:
   ```
   logread | grep -iE "oom|xray|killed|segfault" | grep "Jul 17.*0[56]:5"
   dmesg -T | grep -i xray | tail -30
   ps w | grep xray
   uptime -p; cat /proc/uptime
   ```
2. Проверить, включён ли собственный watchdog PW2 (объясняет, почему автовосстановление
   не случилось за ожидаемые ~58–64 сек):
   ```
   uci get passwall2.@global[0].enabled
   uci get passwall2.@global_delay[0].start_daemon
   ```
3. Подтвердить бэкенд firewall (ожидаем nftables/fw4 на OpenWrt 23.05, но нужно точно):
   ```
   uci get passwall2.@global_forwarding[0].prefer_nft
   ```
4. (Не блокирует ТЗ, но полезно для решения по guard) Измерить реальную длительность
   "дырки" на этом железе: во время `/etc/init.d/passwall2 restart` держать отдельный
   `tcpdump -i <wan_iface>` или прямой (не через SOCKS) `ping`/`curl` цикл и посмотреть,
   сколько реально пакетов успевает пройти прямым путём и сколько это длится по времени.

Пока ответы не получены — раздел 5 (killswitch v2 / guard) остаётся черновым и не в MVP.

## 1. Архитектура

Аддон — не отдельный демон управления трафиком, а три слоя:

1. **Presets Engine** — набор пресетов, каждый — это набор `uci set`/`uci commit passwall2`
   команд + `/etc/init.d/passwall2 reload` (не полный restart, если поддерживается — уточнить
   у PW2, что именно триггерит `stop()+start()` против частичного reload, чтобы минимизировать
   окно из п.0.1). Никаких хардкодов id/названий нод — выбор всегда через discovery (список
   существующих `passwall2.@nodes[*]` по факту, как и раньше в проекте).
2. **Observer (лёгкий)** — переиспользуем существующий по духу `wan_monitor.sh`-подход:
   периодический curl (через SOCKS-порт PW2 для "текущий IP/скорость", и отдельно вне прокси
   для эталона "не утекли ли") + детект `EXIT IP CHANGED` для счётчика переключений. Наблюдает,
   не управляет трафиком — не трогает iptables/nft, поэтому не может создать вторую версию
   бага P18.
3. **LuCI-страницы** (Overview / Nodes / Help) — читают только: (a) состояние из UCI PW2,
   (b) состояние из своего Observer'а. Ничего не дублирует внутреннюю логику PW2.

Явно НЕ строим: свой chooser/failover-движок (это делает Balancing/URLTest), свой
24/7 nft killswitch (см. 0.1).

## 2. Пресеты — приоритет реализации

### Волна 1 (нужна сразу — P1 и P2 из задачи)

**Пресет A — "Лучшая нода" (нативное переключение)**
Настраивает Xray `_balancing` (для Xray-нод) или sing-box `_urltest` (для sing-box-нод) —
выбор движка автоматический по типу нод пользователя, без хардкода.

Выбор стратегии — экспонируется пользователю как понятный выбор (не поле "leastPing" вслепую):

| Опция в UI | Что ставится реально |
|---|---|
| "Самая быстрая" | Xray Balancing `strategy=leastPing`; sing-box `urltest`, `tolerance` низкий (~30-50мс) |
| "Самая стабильная" (по умолчанию) | Xray Balancing `strategy=leastLoad`, `expected` и `tolerance` из пула хороших нод (как уже настроено вручную сейчас: expected=2, tolerance=10) |
| "Ручная с автовозвратом" | SOCKS Auto Switch: `Main node` + `List of backup nodes` + `Restore Switch` — для случая, когда пользователь хочет явно закреплённый основной узел, а не "лучший по метрике" |

Обязательные поля пресета: `fallback_node` **никогда** не Direct (валидатор пресета это
проверяет и блокирует сохранение с явным объяснением почему — см. 0.1, это единственная
защита от утечки, которая реально работает).

**Видимость (обязательное требование, не опция):**
- Overview: текущая активная нода (детект через `curl -x socks5h://127.0.0.1:<port> https://api.ipify.org` — уже проверено вживую в этой сессии, работает), её текущая latency/скорость (наш пробник, т.к. подтверждено кодом — Xray Observatory не даёт live-читаемого API, только генерирует конфиг), счётчик переключений за период (детект `EXIT IP CHANGED`, как в wan_monitor), мини-лог типа WAN Monitor (последние N строк статуса).
- Widget (тот же набор, компактно): нода, скорость, число переключений сегодня, статус (OK/degraded/down).

**Пресет B — "Обход блокировок" (bypass через Shunt)**
Настраивает Shunt-правила: whitelist-домены/подсети (RU/локальные сервисы) → `Direct
Connection` явно, всё остальное → нода/группа из Пресета A. Discovery списка доменов —
из существующих ipset/geosite наборов пользователя, не хардкодим. Это единственное место
во всей архитектуре, где Direct — осознанный, явный выбор, а не аварийный fallback.

### Волна 2 (следующая)

**Пресет C — "Фиксированный IP"**
Отдельное Shunt-правило на конкретные домены (банки/стриминг) → одна закреплённая нода,
не через Balancing/URLTest (чтобы IP не менялся). Обсуждается совмещение с Fallback Node
из Пресета A: если закреплённая нода умирает — либо (а) явно тот же список "хороших" нод как
общий Fallback, либо (б) отдельный собственный fallback именно для этой группы доменов —
предложить пользователю выбор при создании пресета, не решать за него молча.

### Волна 3 (по мере необходимости, после Волны 1-2)

**Расширенный пакет для мощного железа (НЕ MT7621-класс)** — HAProxy Load Balancing и
SOCKS Auto Switch как отдельные опциональные пресеты, скрытые за явным переключателем
"Расширенные настройки" с предупреждением в UI:

> "HAProxy и доп. процессы SOCKS Auto Switch добавляют постоянно работающие процессы и
> health-check запросы. На слабых SoC (MT7621 и аналоги) это заметно ест CPU/память.
> Включайте только если ваш роутер мощнее типового домашнего (x86, ARM64 4+ ядра, ≥512МБ
> свободной памяти) — иначе используйте пресеты A/B."

- **Weight-балансировка (HAProxy)** — если разным нодам нужен разный вес трафика, не только
  "лучшая/резервная".
- **SOCKS Auto Switch с несколькими независимыми профилями** — если нужен не единственный
  глобальный туннель, а несколько параллельных SOCKS-выходов с разными policy.

**Killswitch v2 / boot-и-restart guard** — только после диагностики из 0.2. Если окно
утечки на этом железе оказывается пренебрежимо коротким (десятки мс) — не строим вообще,
экономим сложность. Если существенное — строится не как 24/7 DROP-таблица, а как
временный default-deny, который держится ровно от `stop()` до завершения `start()`
(и на boot — до первого успешного запуска PW2), затем снимается сам.

## 3. UCI-схема аддона (черновик, для обсуждения)

Отдельный конфиг, не смешивается с `passwall2`:

```
config global 'main'
    option preset 'best_node'      # текущий активный пресет (discovery/id, не хардкод значений внутри)
    option strategy 'stable'       # fast|stable|manual — маппится в таблицу §2

config observer 'main'
    option enabled '1'
    option interval '30'           # сек, лёгкий пробник, не 58с как у monitor.sh — отдельный процесс
    option probe_url 'https://api.ipify.org'
    option socks_port ''           # discovery из passwall2.@global[0].node_socks_port, не хардкод

config preset 'bypass'
    option enabled '0'
    list direct_domain_set ''      # discovery из существующих geosite/ipset, не хардкод

config preset 'fixed_ip'
    option enabled '0'
    list domains ''
    option node ''                 # discovery из passwall2.@nodes[*]
    option fallback_mode 'shared'  # shared|dedicated — см. §2 Волна 2
```

## 4. LuCI-страницы (спецификация экранов)

- **Overview** — активный пресет, текущая нода + latency, счётчик переключений (сегодня/за час),
  статус последних N наблюдений (аналог WAN Monitor, компактно), кнопка "тест сейчас".
- **Nodes** — список из PW2 (не дублируем БД), с колонкой "в пуле пресета A: да/нет".
- **Help** — статический текст с объяснением пресетов и предупреждением про Волну 3.
- **Widget** (виджет главной LuCI-страницы) — свёрнутая версия Overview: нода, скорость, статус.

## 5. Порядок реализации (roadmap)

1. Закрыть п.0.2 (диагностика с роутера) — не кодируем вслепую.
2. Прототип Observer (без UI) — переиспользовать/адаптировать существующий wan_monitor-скрипт,
   добавить detection текущей ноды через discovery SOCKS-порта.
3. Пресет A (движок автовыбора) — генератор UCI для Xray Balancing / sing-box URLTest +
   валидатор "fallback ≠ Direct".
4. LuCI Overview + Widget на данных из Observer.
5. Пресет B (bypass через Shunt).
6. Пресет C (фиксированный IP) — Волна 2.
7. Расширенный пакет (HAProxy/SOCKS Auto Switch) с warning-гейтом — Волна 3, только по запросу.
8. Killswitch v2 (guard) — только если п.0.2/измерения это оправдают.

## 6. Источники

- [app.sh](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/root/usr/share/passwall2/app.sh) — старт/стоп, DNS-генерация, отсутствие auto-cleanup при падении Xray.
- [nftables.sh](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/root/usr/share/passwall2/nftables.sh) — правила DNS hijack и TPROXY/REDIRECT, `del_firewall_rule()`.
- [monitor.sh](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/root/usr/share/passwall2/monitor.sh) — встроенный watchdog процессов PW2.
- [GitHub issue #796 "Kill Switch"](https://github.com/xiaorouji/openwrt-passwall2/issues/796) — подтверждение отсутствия нативного killswitch и закрытия фичи как not planned.
- Исследовательский отчёт проекта: `PassWall2-avtoperekliuchenie-proksi-URLTest-health-check-i-balansirovka.md` (Space-файл) — Shunt/Balancing/URLTest/HAProxy/SOCKS Auto Switch механики, GitHub-цитаты на `type/ray.lua`, `type/sing-box.lua`, `util_xray.lua`, `shunt_options.lua`.
- WAN Monitor лог инцидента 2026-07-17 (`paste.txt`, вложение пользователя) — фактические данные по отсутствию утечек и характеру финального обрыва.
