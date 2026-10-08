# Look At Me!

Look At Me! — локальная система объяснимого AI‑прокторинга для Chrome. Она фиксирует наблюдаемые события, сохраняет доказательства и рассчитывает возрастающий **Activity Score 0–200**. Высокий score означает больше обнаруженной подозрительной активности и требует проверки человеком; система не объявляет студента нарушителем автоматически.

## Быстрый запуск готовой сборки

На Windows нужны:

- Google Chrome 116 или новее;
- Python 3.10 или новее; (ОБЯЗАТЕЛЬНЫЙ ПУНКТ, без Python не запустится установщик helper'a и выдаст ошибку)
- веб‑камера.

Node.js для готовой папки `dist` не нужен.

1. Скачайте и распакуйте весь репозиторий.
2. Откройте `chrome://extensions`, включите **Режим разработчика**, нажмите **Загрузить распакованное расширение** и выберите папку `dist`.
3. Откройте (INSTALL_WINDOWS.cmd) в папке с проектом. Установщик сам найдёт ID расширения, загруженного именно из этой папки `dist`, установит bundled Python dependency без интернета, скопирует helper в `%LOCALAPPDATA%\LookAtMe\native-host` и зарегистрирует Native Messaging для текущего пользователя Windows. Важно: после установки расширения в браузер, переходим на этот пункт.
4. Вернитесь в `chrome://extensions` и нажмите **Обновить** на карточке Look At Me!.
5. Откройте обычный сайт или Google Forms, нажмите иконку расширения и выберите **Начать тест**. При первом запуске служебная вкладка Look At Me! запросит камеру и после разрешения сама вернёт вас к тесту; разрешение обычного сайта не является разрешением origin расширения.

Если Chrome хранит несколько копий одной и той же папки, установщик попросит вставить ID из `chrome://extensions`. ID не зашит в проект и может отличаться на другом компьютере или в другом каталоге. (в крайнем случае)

Подробная инструкция для первого запуска находится в [INSTALLATION.md(INSTALLATION.md).

## Как проходит тест

После запуска текущая вкладка переходит в полноэкранный режим. Внутри страницы появляется лёгкий оверлей, а камера, MediaPipe Face Mesh, YOLO и Event Engine продолжают работать в скрытом формате. Интерфейс расширения можно закрыть: это не останавливает сессию.

Интерфейс показывает:

- состояние `NOT READY`, `READY`, `TESTING`, `FINISHING`, `COMPLETED` или `ERROR`;
- Activity Score и количество событий;
- число серьёзных событий;
- состояние камеры и helper;
- живой preview камеры;
- последние события;
- кнопку **Завершить тест**.

Кнопка **Завершить тест** доступна и в popup, и прямо в постоянном оверлее страницы. После вопроса «Вы действительно хотите завершить тест?» система фиксирует последнюю длительность непрерывных событий, дожидается PNG, создаёт обязательный `finalNNN.png`, останавливает CV и helper и штатно выходит из полноэкранного режима. Этот выход не создаёт `FULLSCREEN_EXIT`.

Подтверждённая отправка Google Forms также завершает сессию. Случайная кнопка, обновление, или закрытие popup завершением не считаются.

## Что реально анализируется

- **MediaPipe Face Landmarker / Face Mesh**: наличие и количество лиц, 478 точек на лицо, приблизительная поза поворота головы и приблизительное отклонение взгляда.
- **YOLOv8n COCO через ONNX Runtime Web**: класс `cell phone`, confidence и bounding box. Уверенное распознавание телефона (>50%) создаёт событие на первом подходящем кадре и делает скрин в локальную папку.
- **Chrome APIs и content script**: tab switch, window blur, fullscreen exit, copy, paste и context menu.
- **Python helper**: наблюдение Ctrl+C/V, Alt+Tab, Windows key, Print Screen и foreground process в пределах возможностей Windows user session.

Face‑pipeline и phone‑pipeline работают независимо. Камера не ограничена частотой YOLO: preview обновляется несколько раз в секунду, Face Mesh запускается примерно каждые 120 мс при свободном runtime, YOLO — примерно каждые 600 мс. Перекрывающиеся inference‑вызовы пропускаются.

Один непрерывный `HEAD_TURN` или `LOOKING_AWAY` хранится одной строкой с точными `event_time`, `ended_at` и `duration_ms`. После первой секунды начисляется 4 балла, каждый новый эпизод получает +1 за рецидив, каждая полная дополнительная секунда добавляет +1.

## Локальные данные

Helper использует реальную системную папку **Документы** текущего пользователя (включая перенаправление в OneDrive):

```text
Документы\LookAtMe\
├── database.db
├── recordings\
└── screenshots\
    ├── image001.png
    ├── image002.png
    ├── final001.png
    └── ...
```

`imageNNN.png` содержит видимую страницу теста и текущий кадр камеры. `finalNNN.png` создаётся при каждом штатном завершении, даже когда нарушений не было, и содержит страницу, камеру, Activity Score, время и отметку `FINAL SCREENSHOT`. Существующие номера не перезаписываются.

SQLite содержит:

- `sessions`: студент, тест, начало, конец, длительность, итоговый score, число нарушений, статус и final screenshot;
- `events`: session ID, начало/конец, длительность, confidence, severity, score impact, source, explanation и имя screenshot;
- совместимую таблицу `violations` для ранее сохранённых PNG;
- `final_screenshots` для последовательной нумерации финальных кадров.

Кнопка **Открыть базу нарушений** открывает локальную читаемую страницу. Она показывает helper Online/Offline, время, длительность, тип, confidence, severity, score impact, session ID и PNG. Кнопка **Доказательства** просит helper открыть динамическую папку `screenshots` в Проводнике. Удаление строки удаляет связанный PNG, но не остальные события сессии. При выключенном helper страница не зависает: показывает `Helper: Offline`, а соединение восстанавливается с ограниченным exponential backoff или кнопкой подключения.

`recordings` создаётся для совместимости структуры данных, но текущая версия видео не записывает.

Данные не отправляются в облако. Видео не записывается.

## Сборка из исходников

Для разработки нужны Node.js 20+ и pnpm:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Сборка обновляет готовую папку `dist`. После rebuild повторная регистрация helper не требуется: зарегистрированный host хранится вне `dist` в `%LOCALAPPDATA%`.

Python‑проверки можно выполнить найденным интерпретатором Python 3:

```powershell
python -m unittest discover -s tests -v
python scripts\test_native_agent.py --exercise-storage
```

Полный automated Chrome runtime использует Chrome for Testing:

```powershell
$env:LOOK_AT_ME_CHROME = 'C:\path\to\chrome-for-testing\chrome.exe'
pnpm test:extension-runtime
```

## Структура

- `src/background` — единый session lifecycle, Event Engine, score, Chrome events и Native Messaging;
- `src/offscreen` / `src/proctoring` — камера и независимые MediaPipe/YOLO loops;
- `src/content` — overlay, page events и Google Forms completion;
- `src/popup` — временный UI без владения сессией;
- `src/evidenceViewer` — читаемая локальная база;
- `local_security_agent.py` — Native Messaging и Windows security signals;
- `local_evidence_store.py` — SQLite и атомарная запись PNG;
- `native_host` — переносимый установщик и bundled wheel;
- `public/models` — локальные MediaPipe и YOLO модели;
- `dist` — готовое unpacked расширение.

## Ограничения

- Chrome не может контролировать всю ОС, secure desktop, повышенные процессы или второе физическое устройство.
- Расширение не работает на `chrome://`, Chrome Web Store и других защищённых страницах.
- Head pose и gaze являются приблизительными сигналами, а не точным eye tracking.
- `captureVisibleTab()` сохраняет видимую вкладку Chrome, а не весь рабочий стол.
- Для Native Messaging установка выполняется отдельно для каждого пользователя Windows и актуального динамического extension ID.
- Реальная Google Forms отправка должна быть проверена на конкретной форме организаторов; правила подтверждения дополнительно покрыты unit‑тестами.

Технические детали: [Architecture](docs/ARCHITECTURE.md), [Local Evidence](docs/LOCAL_EVIDENCE.md), [Models](docs/MODELS.md), [Security Agent](docs/SECURITY_AGENT.md), [Decisions](docs/DECISIONS.md).
