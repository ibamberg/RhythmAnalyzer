# Архитектура

Rhythm Analyzer — статическое frontend-only приложение для GitHub Pages. Сборки, backend и фреймворков нет.

## Файлы

- `index.html` — разметка приложения и DOM id.
- `assets/styles.css` — весь визуальный слой.
- `src/config.js` — числовые настройки ввода и анализа.
- `src/meter.js` — размеры, длительность прохода, границы групп и клики метронома.
- `src/durations.js` — соответствие расстояния между ударами музыкальной длительности.
- `src/pass-utils.js` — очистка hitMs, перевод hitMs в position и квантование.
- `src/rhythm-core.js` — анализ проходов, выбор эталона, сравнение и confidence.
- `src/render-core.js` — модель таймлайна и HTML/SVG строка нотной дорожки. DOM не трогает.
- `src/metronome.js` — Web Audio метроном и границы проходов.
- `src/audio-input.js` — поиск onset в микрофонном сигнале.
- `src/tap-input.js` — привязка pointer/space к tap input.
- `src/debug-panel.js` — матрица отладки.
- `src/app.js` — DOM, state, события, start/stop, запись ударов и вызовы render/analyze.

## Термины

- `pass` / проход — один полный такт выбранного размера.
- `hitMs` — время удара в миллисекундах от начала прохода.
- `position` — тот же удар в единицах размера. В 4/4 позиция `1` — вторая четверть, в 6/8 позиция `1` — вторая восьмая.
- `duration` — расстояние от удара до следующего удара или границы группы.

## Как hitMs становится duration

1. `app.js` записывает tap или mic onset в текущий проход метронома.
2. `sanitizeHits()` чистит hitMs: привязка около начала к `0`, удаление дублей, отсев вне прохода.
3. `positionFromHitMs()` переводит миллисекунды в позицию.
4. `quantizePosition()` привязывает позицию к ритмической сетке.
5. `rhythm-core` измеряет расстояние до следующего удара или границы группы.
6. `classifyDuration()` выбирает ближайшую длительность.

## Поток данных

`tap-input` / `audio-input` -> `app.recordHit()` -> `state.passMap` -> `rhythm-core.analyzeRhythm()` -> `render-core.buildTimelineModel()` -> `app.renderTimeline()` и `debug-panel`.

## Где менять

- Допуски и лимиты: `src/config.js`.
- Размеры и группировки: `src/meter.js`.
- Таблицу длительностей: `src/durations.js`.
- Очистку и квантование ударов: `src/pass-utils.js`.
- Similarity, confidence и выбор эталона: `src/rhythm-core.js`.
- Нотную дорожку: `src/render-core.js`.
- Матрицу отладки: `src/debug-panel.js`.
- DOM-события, start/stop/reset и связку tap/mic: `src/app.js`.
