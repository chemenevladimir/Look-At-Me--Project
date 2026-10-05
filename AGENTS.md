AGENTS.md

LOOK AT ME! DEVELOPMENT INSTRUCTIONS

Ты работаешь над проектом Look At Me!, локальной системой AI-прокторинга для онлайн-тестирования.

Этот файл содержит обязательные правила разработки.

---

1. PROJECT GOAL

Look At Me! объединяет:

- Computer Vision;
- browser security monitoring;
- Event Engine;
- Activity Score;
- Timeline;
- Evidence;
- Appeals;
- Teacher Dashboard.

Главная концепция:

Explainable AI Proctoring.

Система обнаруживает подозрительные события и предоставляет человеку доказательства и контекст.

AI не должен самостоятельно утверждать, что студент списывал.

---

2. BEFORE EVERY TASK

Перед началом любой задачи:

1. Прочитай этот файл.
2. Прочитай "ROADMAP.md".
3. Определи текущий BLOCK.
4. Определи текущую PHASE.
5. Изучи существующий код, связанный с задачей.
6. Проверь зависимости.
7. Проверь существующую архитектуру.
8. Не начинай реализацию вслепую.

Не переписывай существующий проект без необходимости.

---

3. DEVELOPMENT ORDER

Работай строго по:

ROADMAP.md

Порядок:

BLOCK 1
→ BLOCK 2
→ BLOCK 3
→ BLOCK 4
→ BLOCK 5
→ BLOCK 6
→ BLOCK 7
→ BLOCK 8
→ BLOCK 9
→ BLOCK 10

Внутри блока:

Phase N
→ implement
→ build
→ test
→ fix
→ verify
→ next phase

Не начинай следующий BLOCK, пока текущий BLOCK не проверен.

---

4. NO FAKE AI

Запрещено выдавать mock/stub за работающий AI.

Нельзя использовать:

return true;

return false;

fake confidence;

hardcoded detection;

random detection;

если они используются как замена реальному ML.

Допустимы mock-функции только внутри отдельного Demo Mode.

Основной режим должен использовать реальную реализацию.

Если реальная модель пока не подключена:

1. явно сообщи об этом;
2. не помечай функцию как completed;
3. не утверждай, что AI работает.

---

5. MACHINE LEARNING RULES

Для каждой модели документируй:

- model name;
- runtime;
- input;
- output;
- inference method;
- confidence;
- limitations.

Предпочтение:

browser-compatible models.

Не обучай новую модель с нуля без явной необходимости.

Главная цель проекта:

stable working MVP.

---

6. COMPUTER VISION

CV должен учитывать:

- confidence;
- temporal smoothing;
- frame skipping;
- minimum duration;
- cooldown;
- false positives.

Не создавай событие на каждый frame.

Кратковременные нормальные движения не должны превращаться в серьёзные события.

---

7. EVENT ENGINE

Все события должны проходить через единый Event Engine.

Каждое событие должно иметь примерно:

id
type
timestamp
duration
confidence
severity
scoreImpact
explanation
source

Источники:

cv
browser
system

Не создавать отдельные несовместимые форматы событий.

---

8. ACTIVITY SCORE

Activity Score:

0–200, где 0 означает отсутствие начисленных нарушений, а рост значения означает рост уровня подозрительной активности.

Score должен быть объяснимым.

Учитывать:

- severity;
- confidence;
- duration;
- repetition;
- event type.

Не использовать Score как:

"вероятность списывания".

Не делать:

1 event = cheating.

Score возрастает при обнаружении нарушений, показывает уровень обнаруженной подозрительной активности и требует human review.

---

9. PRIVACY

По возможности CV inference выполняется локально.

Не отправлять весь camera stream в облако без необходимости.

Cloud storage используется для:

- evidence;
- recordings;
- reports;

если соответствующая функция включена.

Не хранить секретные server-side keys в Chrome Extension.

---

10. CHROME EXTENSION

Основная платформа:

Chrome Extension Manifest V3.

Учитывай ограничения:

- extension permissions;
- content scripts;
- service worker;
- tab APIs;
- fullscreen;
- browser security model.

Не обещай функции, которые Chrome технически не позволяет гарантировать.

Особенно:

- невозможно гарантировать отсутствие второго физического устройства;
- невозможно полностью контролировать ОС пользователя только средствами браузерного расширения.

---

11. CODE QUALITY

Пиши:

- readable TypeScript;
- modular code;
- small components;
- clear interfaces;
- reusable utilities.

Не создавать гигантские файлы без необходимости.

Разделяй:

vision
core
browser
storage
ui
dashboard
demo

---

12. ERROR HANDLING

Всегда обрабатывай:

- camera permission denied;
- camera unavailable;
- model loading failure;
- inference failure;
- browser API failure;
- IndexedDB failure;
- cloud failure;
- network failure.

Ошибки должны быть видимыми и понятными.

Не использовать silent failure.

---

13. PERFORMANCE

CV не должен анализировать каждый frame на максимальной частоте без необходимости.

Используй:

- frame skipping;
- throttling;
- debounce;
- cooldown;
- smoothing;
- Web Workers при необходимости.

Старайся сохранять стабильный UI и приемлемый FPS.

---

14. TESTING

После каждой крупной реализации:

1. run build;
2. run TypeScript check;
3. run available tests;
4. manually test relevant functionality;
5. проверить старые функции;
6. исправить regressions.

Не помечай фазу completed только потому, что код компилируется.

---

15. REGRESSION PROTECTION

При исправлении новой функции:

Не ломай старые функции.

Перед изменением изучи зависимости.

Если изменение архитектуры необходимо:

1. объясни почему;
2. сохрани существующее поведение;
3. протестируй связанные компоненты.

---

16. ROADMAP STATUS

После каждой завершённой фазы обновляй:

"ROADMAP.md"

Используй:

[ ] not started

[~] implemented / needs testing

[x] implemented and tested

Нельзя ставить "[x]", если функция не была реально проверена.

---

17. GIT

Работай логическими изменениями.

Рекомендуемые commits:

feat:
fix:
refactor:
test:
docs:

Примеры:

feat: implement face detection

fix: debounce looking away events

feat: add evidence timeline

test: add event engine tests

Не смешивай несвязанные изменения без необходимости.

---

18. DEMO MODE

Demo Mode разрешён для:

- simulated phone detection;
- simulated multiple faces;
- simulated looking away;
- simulated tab switch;
- simulated evidence.

Но Demo Mode должен быть явно отделён от реального режима.

Не выдавать simulation за AI inference.

---

19. COMMUNICATION

После выполнения задачи сообщай:

1. Что реализовано.
2. Какие файлы изменены.
3. Какие зависимости добавлены.
4. Какие команды запускались.
5. Какие тесты пройдены.
6. Что осталось нерешённым.
7. Есть ли технические ограничения.

Не говори "всё готово", если есть незавершённые части.

---

20. WHEN A BUG IS REPORTED

Если пользователь сообщает ошибку:

1. сначала проанализируй ошибку;
2. найди источник;
3. исправь минимально необходимую часть;
4. не переписывай unrelated code;
5. запусти build/tests;
6. проверь, что предыдущая функциональность не сломалась.

Не начинай следующую фазу, пока критическая ошибка текущей фазы не исправлена.

---

21. WHEN CONTEXT IS LOST

Если история разговора больше недоступна:

не пытайся угадывать предыдущие решения.

Восстанови контекст из:

1. "AGENTS.md"
2. "ROADMAP.md"
3. "docs/ARCHITECTURE.md"
4. существующего кода
5. package.json и конфигурации
6. Git history

Сначала определи фактическое состояние проекта.

---

22. DOCUMENTATION

Если архитектурное решение существенно изменилось:

обнови:

"docs/ARCHITECTURE.md"

Если появилось важное техническое решение:

обнови:

"docs/DECISIONS.md"

Не оставляй архитектурные решения только в истории чата.

---

23. SECURITY

Не помещать:

- API secrets;
- service role keys;
- private credentials;
- passwords;
- tokens;

в исходный код extension.

Использовать environment variables или безопасный backend mechanism там, где это необходимо.

---

24. PRIORITY

При конфликте требований используй следующий порядок:

1. Работоспособность.
2. Безопасность.
3. Корректность AI/CV.
4. Стабильность.
5. Сохранение существующей функциональности.
6. Производительность.
7. UX.
8. Красивый код.

Не жертвуй работающей функцией ради косметического улучшения.

---

25. FINAL PRINCIPLE

Главный принцип разработки:

Build → Test → Verify → Document → Continue.

Не:

Generate → Assume → Continue.

Каждый блок должен оставлять проект в запускаемом состоянии.

Look At Me! должен быть настоящим работающим прототипом, а не набором красивых экранов с фальшивым AI.







26! УЛЬТРА ВАЖНО! КРИТИЧЕСКОЕ ДОПОЛНЕНИЕ: ОБЯЗАТЕЛЬНЫЙ СТЕК ХАКАТОНА

Внимание: следующий стек указан в официальном техническом задании кейса и должен быть отражён в реальной реализации проекта.

Не заменяй эти технологии на аналоги без необходимости.

ОБЯЗАТЕЛЬНО:

1. YOLOv8n / YOLOvlin

Использовать для computer vision detection:

- смартфона ("cell phone");
- лиц / объектов, необходимых для прокторинга.

Для смартфона использовать модель, обученную/предобученную на COCO с классом "cell phone", если это соответствует доступной реализации.

Детекция должна быть реальной, с настоящим inference и confidence.

2. MediaPipe Face Mesh

Использовать MediaPipe Face Mesh для:

- face landmarks;
- определения положения головы;
- оценки наклона/поворота головы;
- определения направления взгляда.

Не заменять MediaPipe другим face/gaze решением без технической причины.

3. Защита рабочего окружения

Для OS-level protection использовать отдельный локальный компонент на:

- Python + "keyboard" / "pyautogui",
- либо Electron,

в зависимости от того, какой вариант лучше интегрируется с текущей архитектурой.

Не пытаться выдавать обычное Chrome Extension за полноценный OS-level блокировщик.

Нужно реализовать или максимально приблизить:

- Ctrl+C / Ctrl+V;
- Alt+Tab;
- Win;
- PrtScn;
- переключение окон;
- контроль сторонних приложений/окон, насколько это технически возможно.

АРХИТЕКТУРА

Основной интерфейс:

Chrome Extension / React / TypeScript

Computer Vision:

YOLOv8n / YOLOvlin
+
MediaPipe Face Mesh

Security:

Local Python Agent или Electron

Общий поток:

Chrome Extension
↓
CV + Browser Monitoring
↓
Local Security Agent
↓
Event Engine
↓
Activity Score
↓
Timeline / Evidence / Dashboard

Все CV и security события должны поступать в единый Event Engine.

ВАЖНО

Не удаляй уже реализованные функции.

Не делай mock detection.

Не создавай функции, которые просто возвращают "true/false" без реального анализа.

Не отмечай функцию завершённой только потому, что интерфейс её отображает.

Перед реализацией:

1. Проанализируй текущую архитектуру.
2. Определи, куда добавить YOLO.
3. Определи, куда добавить MediaPipe Face Mesh.
4. Определи способ связи Extension с Local Security Agent.
5. Реализуй.
6. Собери проект.
7. Проведи реальные тесты.
8. Обнови "ROADMAP.md".

Если какая-либо функция технически невозможна в браузере, перенеси её на Local Security Agent, а не симулируй её.

Этот стек является обязательным требованием кейса, поэтому при выборе между альтернативными технологиями приоритет отдаётся указанному стеку.
