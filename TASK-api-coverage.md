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

Типизации 1.136.0, идентификаторов в поверхности: 1558.
Сигнал «у нас» — слово встречается в src/ (кроме тестов): грубо, но без вранья в пользу покрытия.

## Неймспейсы

| API | членов | не тронуто | что именно |
| --- | ---: | ---: | --- |
| AnnotationsAPI | 3 | 2 | addAnnotationCategoryAsync, getAnnotationCategoryByIdAsync |
| BuzzAPI | 7 | 7 | createFrame, createInstance, getBuzzAssetTypeForNode, getMediaContent, getTextContent, setBuzzAssetTypeForNode, smartResize |
| ClientStorageAPI | 4 | 2 | deleteAsync, keysAsync |
| CodegenAPI | 6 | 6 | callback, off, on, once, preferences, refresh |
| ConstantsAPI | 1 | 1 | colors |
| DevResourcesAPI | 4 | 4 | callback, off, on, once |
| MotionAPI | 3 | 1 | playheadPosition |
| ParametersAPI | 3 | 3 | off, on, once |
| PaymentsAPI | 6 | 6 | getPluginPaymentTokenAsync, getUserFirstRanSecondsAgo, initiateCheckoutAsync, requestCheckout, setPaymentStatusInDevelopment, status |
| PluginAPI | 133 | 49 | buzz, callback, closePlugin, createBooleanOperation, createCanvasRow, createCodeBlock, createConnector, createGif … |
| TeamLibraryAPI | 2 | 0 | — |
| TextReviewAPI | 3 | 3 | isEnabled, requestToBeDisabledAsync, requestToBeEnabledAsync |
| TimerAPI | 7 | 7 | pause, remaining, resume, start, state, stop, total |
| UIAPI | 11 | 2 | getPosition, reposition |
| UtilAPI | 4 | 0 | — |
| VariablesAPI | 27 | 7 | createVariableAliasByIdAsync, extendLibraryCollectionByKeyAsync, getLocalVariableCollections, getLocalVariables, getVariableById, getVariableCollectionById, layoutGrid |
| ViewportAPI | 6 | 3 | canvasView, slidesView, zoom |

## Релизы, от свежего к старому (с 1.107.0)

### 1.136.0 — 2026-08-27  (+1, не тронуто 0)

всё тронуто

### 1.134.0 — 2026-08-14  (+7, не тронуто 3)

NonResizableTextMixin.getRangeTextWrapStyle, SublayerDimensionsMixin, TextWrapStyle

### 1.132.0 — 2026-07-29  (+1, не тронуто 1)

MotionAPI.playheadPosition

### 1.131.0 — 2026-07-16  (+18, не тронуто 2)

VideoExportConstraint, VideoExportScale

### 1.130.0 — 2026-06-24  (+98, не тронуто 16)

AnimationStylePropValue, Animations, AvailableAnimationStylePropValue, ComponentPropKeyframeBindings, ComponentPropKeyframeTracks, EffectKeyframeBindings, EffectKeyframeFieldName, EffectManualKeyframeTracks, ManualKeyframeTrack.keyframeOperation, ManualKeyframeTracks, MotionNodeMixin.applyManualKeyframeTrack, MotionNodeMixin.removeManualKeyframeTrack, MotionNodeMixin.setTimelineDuration, PaintKeyframeBinding, PaintManualKeyframeTrack, ShaderPropertyValue

### 1.128.0 — 2026-06-03  (+2, не тронуто 1)

SlotNode.limitViolations

### 1.127.0 — 2026-05-22  (+12, не тронуто 7)

GridLayoutMixin.reorderColumns, GridLayoutMixin.reorderRows, GridTrackReorderOptions, GridTrackReorderOptions.fromIndices, GridTrackReorderOptions.insertionIndex, NoiseEffectBase.noiseSizeVector, TextureEffect.noiseSizeVector

### 1.126.0 — 2026-05-13  (+2, не тронуто 0)

всё тронуто

### 1.125.0 — 2026-04-22  (+1, не тронуто 1)

PluginAPI.createAutoLayout

### 1.124.0 — 2026-03-26  (+3, не тронуто 1)

SlotNode.resetSlot

### 1.123.0 — 2026-01-26  (+51, не тронуто 11)

BrushStrokeProperties, CustomVariableWidthStrokeProperties, CustomVariableWidthStrokeProperties.variableWidthPoints, CustomVariableWidthStrokeProperties.widthProfile, MinimalFillsMixin.setFillsAsync, MinimalStrokesMixin.setStrokesAsync, PresetVariableWidthStrokeProperties, PresetVariableWidthStrokeProperties.widthProfile, TextPathNode.textPathStartData, TransformGroupNode.transformModifiers, VariableWidthStrokeProperties

### 1.122.0 — 2026-01-14  (+1, не тронуто 1)

ExtendedVariableCollection.rootVariableCollectionId

### 1.121.0 — 2025-11-20  (+14, не тронуто 10)

ExtendedVariableCollection.isExtension, ExtendedVariableCollection.parentVariableCollectionId, ExtendedVariableCollection.removeMode, ExtendedVariableCollection.removeOverridesForVariable, ExtendedVariableCollection.variableOverrides, Variable.removeOverrideForMode, Variable.valuesByModeForCollectionAsync, VariableCollection.extend, VariableCollection.isExtension, VariablesAPI.extendLibraryCollectionByKeyAsync

### 1.120.0 — 2025-11-19  (+1, не тронуто 0)

всё тронуто

### 1.119.0 — 2025-10-23  (+26, не тронуто 18)

BuzzAPI, BuzzAPI.createFrame, BuzzAPI.createInstance, BuzzAPI.getBuzzAssetTypeForNode, BuzzAPI.getMediaContent, BuzzAPI.getTextContent, BuzzAPI.setBuzzAssetTypeForNode, BuzzAPI.smartResize, BuzzAssetType, BuzzMediaField.setMediaAsync, BuzzTextField.setValueAsync, PageNode.focusedNode, PluginAPI.buzz, PluginAPI.createCanvasRow, PluginAPI.getCanvasGrid, PluginAPI.moveNodesToCoord, PluginAPI.setCanvasGrid, ViewportAPI.canvasView

### 1.118.0 — 2025-10-09  (+2, не тронуто 1)

FontStyle

### 1.116.0 — 2025-07-17  (+13, не тронуто 4)

GlassEffect.dispersion, GlassEffect.lightAngle, GlassEffect.lightIntensity, GlassEffect.refraction

### 1.115.0 — 2025-07-08  (+19, не тронуто 4)

GridChildrenMixin.gridChildHorizontalAlign, GridChildrenMixin.setGridChildPosition, GridLayoutMixin.appendChildAt, UIAPI.getPosition

### 1.114.0 — 2025-06-13  (+1, не тронуто 0)

всё тронуто

### 1.113.0 — 2025-05-22  (+5, не тронуто 0)

всё тронуто

### 1.111.0 — 2025-05-07  (+89, не тронуто 34)

BaseNonResizableTextMixin.Pick, BaseNonResizableTextMixin.getRangeBoundVariable, BaseNonResizableTextMixin.getRangeFillStyleId, BaseNonResizableTextMixin.getRangeFills, BaseNonResizableTextMixin.getRangeFontSize, BaseNonResizableTextMixin.getRangeFontWeight, BaseNonResizableTextMixin.getRangeHyperlink, BaseNonResizableTextMixin.getRangeLetterSpacing, BaseNonResizableTextMixin.getRangeOpenTypeFeatures, BaseNonResizableTextMixin.getRangeTextCase, BaseNonResizableTextMixin.getRangeTextStyleId, BaseNonResizableTextMixin.setRangeFillStyleId, BaseNonResizableTextMixin.setRangeFillStyleIdAsync, BaseNonResizableTextMixin.setRangeTextStyleId, BlurEffectProgressive.endOffset, BlurEffectProgressive.startOffset, BlurEffectProgressive.startRadius, NoiseEffect, NoiseEffectBase.density, NoiseEffectBase.noiseSize, NoiseEffectDuotone, NoiseEffectDuotone.noiseType, NoiseEffectDuotone.secondaryColor, NoiseEffectMonotone, NoiseEffectMonotone.noiseType, NoiseEffectMultitone.noiseType, NonResizableTextPathMixin, PatternPaint.horizontalAlignment, PatternPaint.scalingFactor, PatternPaint.sourceNodeId, PatternPaint.tileType, TextPathNode.handleMirroring, TextureEffect.clipToShape, TextureEffect.noiseSize

### 1.110.0 — 2025-04-17  (+15, не тронуто 6)

AnnotationCategory.isPreset, AnnotationCategory.setColor, AnnotationCategory.setLabel, AnnotationCategoryColor, AnnotationsAPI.addAnnotationCategoryAsync, AnnotationsAPI.getAnnotationCategoryByIdAsync

### 1.108.0 — 2025-02-26  (+24, не тронуто 13)

BaseNodeMixin.getTopLevelFrame, InteractiveSlideElementNode, InteractiveSlideElementNode.interactiveSlideElementType, PageNode.focusedSlide, PluginAPI.createSlide, PluginAPI.createSlideRow, PluginAPI.getSlideGrid, PluginAPI.setSlideGrid, SlideGridNode, SlideNode.getSlideTransition, SlideNode.isSkippedSlide, SlideNode.setSlideTransition, ViewportAPI.slidesView
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

### 2. Расширяемые коллекции переменных — 1.121–1.122, не тронуты

`VariableCollection.extend`, `ExtendedVariableCollection.*`, `Variable.removeOverrideForMode`,
`valuesByModeForCollectionAsync`, `VariablesAPI.extendLibraryCollectionByKeyAsync`.

Почему важно: это ровно та боль, которая уже есть в файле — `content/strong` приходит из чужой
библиотеки, 78 из 135 переменных в One не опубликованы. Расширение библиотечной коллекции —
механизм, которым это чинится, и канал о нём не знает.

### 3. Ручные ключевые кадры — ЗАКРЫТО

`MotionNodeMixin.applyManualKeyframeTrack`, `removeManualKeyframeTrack`, `setTimelineDuration`,
все `ManualKeyframeTrack*`, `EffectKeyframe*`, `PaintKeyframeBinding`, `MotionAPI.playheadPosition`.

`keyframes: [{ field, from?, at: [{ time, value, easing? }] }]` и `timeline: <секунды>`. Тридцать
анимируемых полей носят те же имена, что и всё остальное в словаре — `x`, `gap`, `cornerRadius`,
`trimStart` — против фигмовских `TRANSLATION_X`, `STACK_SPACING`, `PATH_TRIM_START`.

Проверено: три дорожки записаны через канал, прочитаны обратно один в один, узел проходит
прогон. GIF показывает движение.

### 4. Figma Draw — переменная ширина ЗАКРЫТА

`strokeProfile` — именованный профиль (`TAPER`, `WEDGE`, `EYE`…) или собственные точки
`[{ at, width }]`. Проверено: линия, тонкая по краям и толстая в середине, записана, прочитана и
пройдена прогоном начисто.

Остаются `transformModifiers` у `TransformGroupNode`, `textPathStartData` и асинхронные
`setFillsAsync` / `setStrokesAsync` — они не про вид экрана, а про удобство редактирования.

### 5. Эффекты 2025 года — ЗАКРЫТО

Шум (моно/дуо/мульти), текстура, стекло и прогрессивное размытие — все в словаре, и
**список эффектов теперь читается массивом**, а не прозой: половина дизайна экрана это его тени.

Осталcя `PatternPaint` — заливка узором из другого узла; она про иллюстрации, не про экраны.

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

### 7. Гриды — 1.115, 1.127

`setGridChildPosition`, `appendChildAt`, `gridChildHorizontalAlign`, `reorderRows`,
`reorderColumns`.

### 8. Осознанно отложено

- **Slides** (1.108) и **Buzz** (1.119) — другие редакторы, к экранам отношения не имеют.
  В интервью названы, но на цель не работают; берём после первых семи.
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
