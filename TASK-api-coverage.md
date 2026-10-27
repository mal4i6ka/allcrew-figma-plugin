# Реестр покрытия Figma Plugin API

Список «свежих областей», по которому мы договорились считать покрытие законченным
(см. память `export-scaffold-direction`). Он **выведен, а не составлен**: список, который кто-то
переписал руками, устаревает через неделю.

Пересобрать:

```bash
node agent/api-coverage.mjs --releases 1.107.0
```

**Откуда берутся два столбца.** Поверхность — из `@figma/plugin-typings`, как они установлены:
каждый интерфейс, тип и член. Порядок — из diff между опубликованными версиями тех же
типизаций: что каждый релиз *добавил*, от свежего к старому. Ченджлог рассказывает, что Figma
сочла достойным анонса; diff показывает, что появилось на самом деле.

**Что значит «тронуто».** Слово встречается в `src/` (без тестов). Сигнал нарочно грубый —
разбирать, какая команда до какого вызова доходит, значило бы написать вторую программу со
своими ошибками. Но он дважды переделан, чтобы не льстить: члены ищутся *с точкой*
(`.getRangeFills`, а не `getRangeFills`), иначе `on` у `DevResourcesAPI` совпадал с каждым нашим
слушателем событий и dev resources выглядели покрытыми на три четверти при нуле вызовов;
а неймспейс считается недостижимым целиком, если `figma.<accessor>` не встречается нигде.
Тип, который мы просто не упоминаем, при этом пробелом не считается — мы почти ничего не
аннотируем, и `MotionAPI` не встречается в исходнике, хотя `figma.motion` зовётся на каждой
анимации.

---
<!-- api-coverage:start -->

Типизации 1.142.0, идентификаторов в поверхности: 1597.
Сигнал «у нас» — слово встречается в src/ (кроме тестов): грубо, но без вранья в пользу покрытия.

## Неймспейсы

| API | членов | не тронуто | что именно |
| --- | ---: | ---: | --- |
| AnnotationsAPI | 3 | 0 | — |
| BuzzAPI | 7 | 7 | createFrame, createInstance, getBuzzAssetTypeForNode, getMediaContent, getTextContent, setBuzzAssetTypeForNode, smartResize |
| ClientStorageAPI | 4 | 2 | deleteAsync, keysAsync |
| CodegenAPI | 6 | 2 | callback, refresh |
| ConstantsAPI | 1 | 1 | colors |
| DevResourcesAPI | 4 | 4 | callback, off, on, once |
| MotionAPI | 3 | 0 | — |
| ParametersAPI | 3 | 3 | off, on, once |
| PaymentsAPI | 6 | 6 | getPluginPaymentTokenAsync, getUserFirstRanSecondsAgo, initiateCheckoutAsync, requestCheckout, setPaymentStatusInDevelopment, status |
| PluginAPI | 141 | 34 | buzz, callback, closePlugin, createBooleanOperation, createCanvasRow, createCodeBlock, createConnector, createGif … |
| TeamLibraryAPI | 2 | 0 | — |
| TextReviewAPI | 3 | 3 | isEnabled, requestToBeDisabledAsync, requestToBeEnabledAsync |
| TimerAPI | 7 | 7 | pause, remaining, resume, start, state, stop, total |
| UIAPI | 11 | 2 | getPosition, reposition |
| UtilAPI | 7 | 1 | alphaOverride |
| VariablesAPI | 27 | 5 | createVariableAliasByIdAsync, getLocalVariableCollections, getLocalVariables, getVariableById, getVariableCollectionById |
| ViewportAPI | 6 | 2 | canvasView, slidesView |

## Релизы, от свежего к старому (с 1.107.0)

### 1.142.0 — 2026-10-16  (+8, не тронуто 1)

UtilAPI.alphaOverride

### 1.141.0 — 2026-10-05  (+2, не тронуто 0)

всё тронуто

### 1.140.0 — 2026-09-30  (+25, не тронуто 2)

PluginAPI.getLocalCustomAnimationStyles, PluginAPI.targetNode

### 1.139.0 — 2026-09-23  (+1, не тронуто 0)

всё тронуто

### 1.138.0 — 2026-09-03  (+7, не тронуто 0)

всё тронуто

### 1.136.0 — 2026-08-27  (+1, не тронуто 0)

всё тронуто

### 1.134.0 — 2026-08-14  (+7, не тронуто 3)

NonResizableTextMixin.getRangeTextWrapStyle, SublayerDimensionsMixin, TextWrapStyle

### 1.132.0 — 2026-07-29  (+1, не тронуто 0)

всё тронуто

### 1.131.0 — 2026-07-16  (+18, не тронуто 2)

VideoExportConstraint, VideoExportScale

### 1.130.0 — 2026-06-24  (+98, не тронуто 12)

Animations, AvailableAnimationStylePropValue, ComponentPropKeyframeBindings, ComponentPropKeyframeTracks, EffectKeyframeBindings, EffectKeyframeFieldName, EffectManualKeyframeTracks, ManualKeyframeTrack.keyframeOperation, ManualKeyframeTracks, PaintKeyframeBinding, PaintManualKeyframeTrack, ShaderPropertyValue

### 1.128.0 — 2026-06-03  (+2, не тронуто 0)

всё тронуто

### 1.127.0 — 2026-05-22  (+12, не тронуто 0)

всё тронуто

### 1.126.0 — 2026-05-13  (+2, не тронуто 0)

всё тронуто

### 1.125.0 — 2026-04-22  (+1, не тронуто 1)

PluginAPI.createAutoLayout

### 1.124.0 — 2026-03-26  (+3, не тронуто 0)

всё тронуто

### 1.123.0 — 2026-01-26  (+51, не тронуто 4)

BrushStrokeProperties, MinimalFillsMixin.setFillsAsync, MinimalStrokesMixin.setStrokesAsync, VariableWidthStrokeProperties

### 1.122.0 — 2026-01-14  (+1, не тронуто 0)

всё тронуто

### 1.121.0 — 2025-11-20  (+14, не тронуто 0)

всё тронуто

### 1.120.0 — 2025-11-19  (+1, не тронуто 0)

всё тронуто

### 1.119.0 — 2025-10-23  (+26, не тронуто 18)

BuzzAPI, BuzzAPI.createFrame, BuzzAPI.createInstance, BuzzAPI.getBuzzAssetTypeForNode, BuzzAPI.getMediaContent, BuzzAPI.getTextContent, BuzzAPI.setBuzzAssetTypeForNode, BuzzAPI.smartResize, BuzzAssetType, BuzzMediaField.setMediaAsync, BuzzTextField.setValueAsync, PageNode.focusedNode, PluginAPI.buzz, PluginAPI.createCanvasRow, PluginAPI.getCanvasGrid, PluginAPI.moveNodesToCoord, PluginAPI.setCanvasGrid, ViewportAPI.canvasView

### 1.118.0 — 2025-10-09  (+2, не тронуто 1)

FontStyle

### 1.116.0 — 2025-07-17  (+13, не тронуто 0)

всё тронуто

### 1.115.0 — 2025-07-08  (+19, не тронуто 2)

GridLayoutMixin.appendChildAt, UIAPI.getPosition

### 1.114.0 — 2025-06-13  (+1, не тронуто 0)

всё тронуто

### 1.113.0 — 2025-05-22  (+5, не тронуто 0)

всё тронуто

### 1.111.0 — 2025-05-07  (+89, не тронуто 16)

BaseNonResizableTextMixin.Pick, BaseNonResizableTextMixin.getRangeBoundVariable, BaseNonResizableTextMixin.getRangeFillStyleId, BaseNonResizableTextMixin.getRangeFills, BaseNonResizableTextMixin.getRangeFontSize, BaseNonResizableTextMixin.getRangeFontWeight, BaseNonResizableTextMixin.getRangeHyperlink, BaseNonResizableTextMixin.getRangeLetterSpacing, BaseNonResizableTextMixin.getRangeOpenTypeFeatures, BaseNonResizableTextMixin.getRangeTextCase, BaseNonResizableTextMixin.getRangeTextStyleId, BaseNonResizableTextMixin.setRangeFillStyleId, BaseNonResizableTextMixin.setRangeTextStyleId, NoiseEffect, NonResizableTextPathMixin, TextPathNode.handleMirroring

### 1.110.0 — 2025-04-17  (+15, не тронуто 0)

всё тронуто

### 1.108.0 — 2025-02-26  (+24, не тронуто 12)

InteractiveSlideElementNode, InteractiveSlideElementNode.interactiveSlideElementType, PageNode.focusedSlide, PluginAPI.createSlide, PluginAPI.createSlideRow, PluginAPI.getSlideGrid, PluginAPI.setSlideGrid, SlideGridNode, SlideNode.getSlideTransition, SlideNode.isSkippedSlide, SlideNode.setSlideTransition, ViewportAPI.slidesView

<!-- api-coverage:end -->
---

## Приоритеты — по цели выгрузки, не по дате

### 1. Dev Mode — ЗАКРЫТ (кроме codegen)

Было: ноль вызовов на всех трёх — ссылки на код, родные аннотации, измерения. То, что в нашем
исходнике звалось `annotations`, — это **наши** i18n-аннотации на TEXT-узлах; имя совпало,
покрытия не было.

Стало: `DEV_LINK_LIST` / `DEV_LINK_SET`, `ANNOTATE`, `MEASURE_LIST` / `MEASURE_SET`, и всё это
читается обратно в `NODE_QUERY props:true` — `devLinks` и `annotations` на самом узле.

**Codegen закрыт вместе с React-эмиттером.** Манифест объявляет `codegen`, и панель Dev Mode
показывает то же самое, что отдаёт `EMIT_REACT` — не второй эмиттер, а второй вход в один
конвейер: разработчик, читающий панель, и разработчик, читающий репозиторий, не могут смотреть
на разный код.

Строка `DevResourcesAPI` в таблице выше остаётся нулевой и это не ошибка: там события
(`on`/`off`/`once`) для плагина-генератора, а узловые методы живут в `DevResourcesMixin` и
покрыты.

### 2. Расширяемые коллекции переменных — ЗАКРЫТО

`VariableCollection.extend`, `ExtendedVariableCollection.*`, `Variable.removeOverrideForMode`,
`VariablesAPI.extendLibraryCollectionByKeyAsync` — пишутся через `collections.update`.

Оставалось чтение, и там была настоящая дыра: у переменной `variableCollectionId` указывает на
**корень**, поэтому расширение попадало в снапшот коллекцией с режимами и без единой переменной —
и целый бренд молча пропадал из `tokens.emit`. Теперь `readLocalVariables` берёт значения через
`valuesByModeForCollectionAsync` (на старом хосте — `variableOverrides` поверх родительских) и
сворачивает их (`src/tokens/extensions.ts`): при локальном корне режимы расширения становятся ещё
режимами корня — «Brand B Light», «Brand B Dark», то есть темами тех же токенов; при библиотечном
корне расширение остаётся своей коллекцией и несёт унаследованные переменные.

### 3. Ручные ключевые кадры — ЗАКРЫТО

`MotionNodeMixin.applyManualKeyframeTrack`, `removeManualKeyframeTrack`, `setTimelineDuration`,
все `ManualKeyframeTrack*`, `EffectKeyframe*`, `PaintKeyframeBinding`, `MotionAPI.playheadPosition`.

`keyframes: [{ field, from?, at: [{ time, value, easing? }] }]` и `timeline: <секунды>`. Тридцать
анимируемых полей носят те же имена, что и всё остальное в словаре — `x`, `gap`, `cornerRadius`,
`trimStart` — против фигмовских `TRANSLATION_X`, `STACK_SPACING`, `PATH_TRIM_START`.

Проверено: три дорожки записаны через канал, прочитаны обратно один в один, узел проходит
прогон. GIF показывает движение.

Дописано позже — два разрыва, которые «закрыто» не замечало:

- **Дорожку нельзя было снять.** `removeManualKeyframeTrack` не звался ни разу: `at: null` снимает
  одну дорожку, `keyframes: []` или `null` — все.
- **Краски и эффекты не анимировались.** Индексные поля (`INDEXED_ITEM`) не читались и не
  писались — а «тень растёт при наведении» и «цвет меняется» и есть самые частые анимации.
  Теперь `field` берёт `fill`, `stroke[1]`, `effect.radius`, `effect[1].color` — слова после точки
  те же, которыми эффект строится (`x`, `y`, `radius`, `spread`, `color`, `second`, `opacity`,
  `density`, `startRadius`, у стекла `depth`, `refraction`, `dispersion`, `lightAngle`,
  `lightIntensity`). Значение цвета — `"#RRGGBB"`, `"#RRGGBB @0.5"` или CSS-цвет; чтение отдаёт
  ту же строку.

`ManualKeyframeTrack.keyframeOperation` (SET/OFFSET/SCALE) осознанно не читается: это поле
сводного `animations`, где лежат и дорожки от стилей анимации, а ручные дорожки всегда
абсолютные — для round-trip оно ничего не меняет.

### 4. Figma Draw — переменная ширина ЗАКРЫТА

`strokeProfile` — именованный профиль (`TAPER`, `WEDGE`, `EYE`…) или собственные точки
`[{ at, width }]`. Проверено: линия, тонкая по краям и толстая в середине, записана, прочитана и
пройдена прогоном начисто.

Дописано позже: `repeat` читает и перенастраивает `transformModifiers` у существующей
TRANSFORM_GROUP (раньше её можно было только создать через `NODE_GROUP as: "repeat"`; разбор теперь
один на оба места — `repeatModifier`), `textStart: [сегмент, позиция]` читает и двигает
`textPathStartData` у текста на пути (без него копия начинала текст там, где начинается контур).
`setFillsAsync` / `setStrokesAsync` зовутся для узора — см. пункт 5.

### 5. Эффекты 2025 года — ЗАКРЫТО

Шум (моно/дуо/мульти), текстура, стекло и прогрессивное размытие — все в словаре, и
**список эффектов теперь читается массивом**, а не прозой: половина дизайна экрана это его тени.

`PatternPaint` — заливка узором из другого узла — тоже в словаре: `{ pattern: "<id>", tile,
scale, spacing: [x, y], align }`, пишется через `setFillsAsync` / `setStrokesAsync` (единственный
путь, который ждёт загрузки исходного узла), читается в той же форме.

Две находки на холсте: `blendMode` у шума есть в типизациях и отвергается рантаймом (второй такой
случай за сезон), а полупрозрачная краска читалась как `"#FFFFFF @0.1"` и не принималась назад —
это ломало прогон каждого оверлея в файле.

### 6. Диапазоны текста — ЗАКРЫТО

`text.segments` зовёт `getStyledTextSegments(['boundVariables', 'fills'])` — и всё. Текст, у
которого одно слово другого кегля, со ссылкой, капителью или своим текстовым стилем, читается
как однородный: `runs` мы **пишем**, но обратно они не приходят.

Починено списком полей в одном вызове; отдельные `getRangeX` из 1.111 при этом не нужны вовсе —
они дают то же самое по одному полю за раз. Попутно вскрылись ещё три разрыва round-trip, все на
каждом слое, а не только на тексте: `fontName` читался строкой `"Inter Regular"` при записи,
требующей `{ family, style }`; связанная краска читалась как `"var:surface/l0"` и отклонялась;
`sizing` печатался сверху узла, а принимался только внутри `layout`.

Проверено так, как просит условие остановки: текст с тремя стилевыми диапазонами прочитан,
прочитанное отправлено обратно как `NODE_CREATE`, копия сверена с оригиналом посвойственно —
13 из 13 совпали, вместе с `runs`.

Дописано позже: из ~25 полей `getStyledTextSegments` диапазоны знали 9. Добавлены `textStyle` и
`fillStyle` на части текста (`setRangeTextStyleIdAsync` / `setRangeFillStyleIdAsync` — подзаголовок
внутри абзаца), списки `list: ORDERED|UNORDERED|NONE` и `indent` (уровень вложенности),
`listSpacing`, `paragraphSpacing`, `paragraphIndent` — в обе стороны. И `decoration: { style:
SOLID|WAVY|DOTTED, offset, thickness, color, skipInk }` — как нарисовано подчёркивание; этого не
было даже на уровне узла, так что волнистая цветная ссылка копировалась прямой и чёрной. Теперь
оно есть и на узле, и в диапазоне; по умолчанию Figma не печатается вовсе.

`openTypeFeatures` осознанно не читается: в Plugin API оно только для чтения, и прогон получил бы
«прочитано, но не пишется» на каждом тексте с капителью.

### 7. Гриды — ЗАКРЫТО

Чтение печатало только число дорожек, поэтому копия грида `1fr 240px` возвращалась равными
дорожками с гэпом потока — другой раскладкой, похожей на исходную. Теперь в `layout`:
`rowGap` / `columnGap` (у грида свои два гэпа), `rowSizes` / `columnSizes` (число — пиксели,
`"1fr"` — доля, `"hug"` — по содержимому; длина обязана совпасть с `rows`/`columns`),
`positioning` (`MANUAL` / `ROW_AUTO_FLOW`) и действия `moveRows` / `moveColumns`
(`reorderRows`/`reorderColumns`: `{ from: [индексы], to }`, счёт по порядку ДО перестановки). У
ребёнка — `gridCell: { row, column }` (`setGridChildPosition`, ждёт, пока узел окажется в
родителе; читается только в MANUAL-гриде — в авто-потоке ячейку выбрал грид) и
`gridAlign: { horizontal, vertical }` (одно слово — по-прежнему вертикаль).

`appendChildAt` не нужен отдельно: «добавить ребёнка, затем `gridCell`» — то же самое.

### 8. Краски в форме записи — ЗАКРЫТО

Чтение `fill`/`stroke` шло через `describePaints` — строку для отчёта: `image:3f9a… FILL`,
`gradient:linear #FFF → #000`, две краски через ` + `. Ни одну из них запись не принимала, так что
**каждая картинка, каждый градиент и каждый стек красок выпадал из прогона** как `dropped`;
экран из пункта 6 прошёл, потому что был на сплошных цветах.

Теперь (`src/canvas/paint-reader.ts`) обычный случай остаётся той же короткой строкой, а остальное
выходит объектом записи: `{ gradient, from, to, stops }` — ручки восстанавливаются из матрицы
обратным к `gradientTransform` преобразованием (`gradientEnds`, с флагом `skewed` для
эллиптического/скошенного, который двумя ручками не описать); `{ image: { hash }, scaleMode }`;
`{ video: { hash } }`; список — для стека. Связанная краска с прозрачностью — `{ variable,
opacity }`, и запись теперь эту прозрачность сохраняет (раньше молча теряла). То же — у
заливки диапазона текста и в `SELECTION_COLORS`.

Видео пишется: `{ video: { hash } }` или `{ video: { bytes } }` через `createVideoAsync` (URL Figma
не принимает; загрузка — только в платной команде).

### 9. Остальное по свежим релизам — ЗАКРЫТО

- **Шум и текстура, 1.127** — `size: [x, y]` для вытянутого зерна (`noiseSizeVector`), в обе
  стороны.
- **Слоты, 1.124 / 1.128** — `reset: true` на SLOT зовёт `resetSlot`; чтение говорит
  `slotViolations` (`BELOW_MIN`, `ABOVE_MAX`, `HAS_NON_PREFERRED`), прогон считает это вердиктом,
  а не свойством.
- **Категории аннотаций, 1.110** — `ANNOTATION_CATEGORIES` и `ANNOTATION_CATEGORY_SET`
  (add / edit — `setLabel`, `setColor` / remove; пресеты не удаляются).
- **Страницы-разделители** — `PAGE_CREATE divider: true` (`createPageDivider`), `PAGE_LIST`
  помечает их `divider: true`.
- **`SELECTION_COLORS`** (`getSelectionColors`), **`FILE_THUMBNAIL`** / **`FILE_THUMBNAIL_SET`**
  (обложка файла), **`UNDO`** (`triggerUndo` — каждая запись канала закрывает свой шаг отмены,
  так что это ровно «отмени мою последнюю запись», если дизайнер с тех пор ничего не делал).
- **`NODE_CREATE kind: "slice"`** (`createSlice`) — область экспорта; строки экспорта ей даёт
  `export.configure`.
- **`node.focus zoom`** — держать масштаб (`viewport.zoom`) с центром на узлах; ответ называет
  итоговый вьюпорт.

**Ложные пробелы отчёта** — сигнал «слово с точкой» их не видит, но вызов есть:
`setFillsAsync` / `setStrokesAsync` (зовутся как `bag[setter]`), `VideoExportConstraint` /
`VideoExportScale` (`NODE_EXPORT` строит их для MP4/GIF/WEBM), `BrushStrokeProperties` /
`VariableWidthStrokeProperties` (типы за `brush` и `strokeProfile`),
`UtilAPI.alphaOverride` (позиционный аргумент `figma.util.rgba(colour, alpha)`),
`PluginAPI.targetNode` (имя параметра `moveLocal*StyleAfter`), `getRangeTextWrapStyle`
(читается через `getStyledTextSegments(['textWrapStyle'])`, пишется `setRangeTextWrapStyle`),
синхронные `getLocal*Styles` / `getStyleById` / `getFileThumbnailNode` /
`getLocalCustomAnimationStyles` (используются Async-версии).

**Не наш редактор:** `SublayerDimensionsMixin` (подпись коннектора FigJam), `getCanvasGrid` /
`setCanvasGrid` / `createCanvasRow` / `moveNodesToCoord` (только Slides и Buzz), `createSticky`,
`createConnector`, `createShapeWithText`, `createCodeBlock`, `createTable`, `createGif`,
`createLinkPreviewAsync` (FigJam), `createNodeFromJSXAsync` (виджеты).

### 10. Осознанно отложено

- **Slides** (1.108) и **Buzz** (1.119) — другие редакторы, к экранам отношения не имеют.
  В интервью названы, но на цель не работают.
- **PaymentsAPI**, **TimerAPI**, **TextReviewAPI**, **ParametersAPI**, **ConstantsAPI** — не наш
  сценарий вообще.
- **`PluginAPI.createAutoLayout`**, **`createBooleanOperation`** и прочие удобные конструкторы —
  у нас те же узлы делаются через `NODE_CREATE` и `NODE_GROUP`.

## Инструмент прогона

`NODE_ROUNDTRIP` — читает узел, строит копию **только из прочитанного**, читает копию, сверяет,
копию убирает. Три исхода названы отдельно, потому что значат разное: `dropped` — чтение держит
свойство, которого не берёт запись; `failed` — запись взяла, Figma отказала; `diverged` — прошло,
но копия вернулась другой. Судья того, что «отправляемо», — сам планировщик, а не второй список.

```bash
node agent/allcrew-channel.mjs call plugin.call '{"command":"NODE_ROUNDTRIP","params":{"nodes":["<id>"],"depth":8}}'
```

Первый прогон по тайлу нашёл 69 расхождений. Все оказались одним классом — **чтение печатает
по-человечески, запись это не принимает**:

| читалось | стало приниматься |
|---|---|
| `bind: "itemSpacing=var:spacing/m · …"` | объект `{ itemSpacing: "spacing/m" }` |
| `lineHeight: "16px"`, `letterSpacing: "-0.32px"` | суффикс `px` наравне с `%` |
| `properties: "Label=Готово · Show dot=false"` | объект `{ Label: "Готово" }` |
| `strokeWeight: null` у слоя без обводки | не печатается вовсе |
| имя удалённой переменной `spacing/m` | ищется в подключённых библиотеках |

Последнее — пункт 2 этого же реестра, всплывший на практике: резолвер знал ключ библиотеки, но
не имя, и «spacing/m» из One не находился. Попутно там же был мой собственный баг: слэш в
`spacing/m` принимался за имя коллекции, хотя токены сами полны слэшей.

**Экран целиком проходит прогон начисто** — 8 свойств из 8, включая привязку к удалённой
библиотеке.

### Что инструмент назвал пределом, а не дефектом

- ~~**Оверрайды внутри инстансов не переезжают.**~~ — **закрыто**. `overrides` стало свойством
  словаря: `[{ at: "<id ребёнка внутри инстанса>", props }]`. Адрес — часть id после id самого
  инстанса, и он одинаков в любом инстансе того же компонента: это и делает оверрайд, снятый с
  одного, применимым к копии. Читается из `instance.overrides` (Figma сама говорит, какие узлы и
  какие поля), пишется обходом в ту же сторону.

  Попутно нашлось, что **оверрайд бывает снятием**: у последней строки тайла дизайнер убрал
  разделитель, чтение не печатало того, чего нет, оверрайд терялся и копия возвращалась с линией
  компонента. Теперь у инстанса пустая заливка и пустая обводка читаются как `"none"` — на
  инстансе пусто это решение, а не обычное дело.
- **`network`, `brush`, `timelines`, `shader` читаются сводкой** («13 point(s), 13 segment(s)»).
  Для обычного чтения это правильно, но скопированный вектор выходит пустым.
- ~~**Прототипные связи** читаются прозой~~ — **закрыто**. `links` читаются массивом в том виде,
  в каком запись их берёт: триггер словом, миллисекунды секундами, направление обратно в слово
  (`PUSH` + `LEFT` → `PUSH_LEFT`), пружина пружиной, условие как `if` / `then` / `else`. Чего
  словарь не умеет сказать — называется в `unread`, а не пропадает.

  **Экран целиком с прототипом проходит прогон начисто**: `ok: true`, ни одного `dropped`,
  `failed` или `diverged`, и связи действительно доезжают — в копии та же `press → 570:15184
  CHANGE_TO DISSOLVE 0.05s`.

## Что считается закрытым

Условие остановки — конъюнкция: пункты 1–7 закрыты **и** любой экран читается через канал так,
что прочитанное можно отправить обратно и получить то же самое. Второе проверяется не глазами:
нужен прогон «прочитать экран → создать по прочитанному → сравнить», и его пока нет.

## 11. Редакторы: FigJam, Slides, Buzz — ЗАКРЫТО

Манифест называет все пять редакторов (`figma`, `dev`, `figjam`, `slides`, `buzz`) и просит
`activeusers` и `fileusers`. Сравнение API по редакторам — `docs/editors.md`. Итог:
все 45 членов typings с пометкой «only available in …» достигнуты из `src/`.

- FigJam: `sticky`, `shapeWithText`, `connector`, `codeBlock`, `table`, `linkPreview`, `gif` в
  `NODE_CREATE`; свойства `wide`, `authorVisible`, `shapeType`, `connector`, `code`,
  `codeLanguage`, `table`, `stuckTo`; текст стикера/фигуры/коннектора пишется теми же `text`,
  `fontSize`, `fontName`, `runs` через подслой. `figjam.board`, `figjam.timer`.
- Slides: `slide`, `slideRow` (`at: [row, column]`); `skipped`, `transition`. `canvas.grid`,
  `canvas.arrange` (сетка, перенос, новый ряд, фокус, вид).
- Buzz: `asset` (`at`, `of` — компонент); `assetType`. `buzz.content`, `buzz.content.set`,
  `buzz.resize` (smartResize).
- Design-only команды (компоненты, стили) в других редакторах отказывают с именем нужного
  редактора, а не падают на «not a function». `editor.capabilities` — что можно здесь.
- Осознанно нет: запись состояния чужого виджета (API разрешает только самому виджету),
  `rescale` (есть `width`/`height`), запись `authorName` (подделка авторства).

