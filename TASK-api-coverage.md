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
| AnnotationsAPI | 3 | 3 | addAnnotationCategoryAsync, getAnnotationCategoriesAsync, getAnnotationCategoryByIdAsync |
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

### 1.110.0 — 2025-04-17  (+15, не тронуто 9)

Annotation.categoryId, AnnotationCategory.isPreset, AnnotationCategory.setColor, AnnotationCategory.setLabel, AnnotationCategoryColor, AnnotationsAPI, AnnotationsAPI.addAnnotationCategoryAsync, AnnotationsAPI.getAnnotationCategoriesAsync, AnnotationsAPI.getAnnotationCategoryByIdAsync

### 1.108.0 — 2025-02-26  (+24, не тронуто 13)

BaseNodeMixin.getTopLevelFrame, InteractiveSlideElementNode, InteractiveSlideElementNode.interactiveSlideElementType, PageNode.focusedSlide, PluginAPI.createSlide, PluginAPI.createSlideRow, PluginAPI.getSlideGrid, PluginAPI.setSlideGrid, SlideGridNode, SlideNode.getSlideTransition, SlideNode.isSkippedSlide, SlideNode.setSlideTransition, ViewportAPI.slidesView


---

## Приоритеты — по цели выгрузки, не по дате

### 1. Dev Mode — не тронут вовсе, и он ближе всех к цели

`DevResourcesAPI` (0 из 4), `CodegenAPI` (0 из 6), `AnnotationsAPI` (0 из 3), `Measurement` /
`MeasurementSide` / `MeasurementOffset` — ноль вызовов. То, что в нашем исходнике зовётся
`annotations`, — это **наши** i18n-аннотации на TEXT-узлах, а не родные аннотации Figma; имя
совпало, покрытие нет.

Почему первым: заготовка обязана нести обратную ссылку в макет. `setDevResourceAsync` кладёт
ссылку на код прямо на узел — это и есть тот самый «комментарий в самом месте», только с той
стороны. Родные аннотации и измерения — то, что дизайнер уже написал для разработчика и что
сейчас в выгрузку не попадает.

### 2. Расширяемые коллекции переменных — 1.121–1.122, не тронуты

`VariableCollection.extend`, `ExtendedVariableCollection.*`, `Variable.removeOverrideForMode`,
`valuesByModeForCollectionAsync`, `VariablesAPI.extendLibraryCollectionByKeyAsync`.

Почему важно: это ровно та боль, которая уже есть в файле — `content/strong` приходит из чужой
библиотеки, 78 из 135 переменных в One не опубликованы. Расширение библиотечной коллекции —
механизм, которым это чинится, и канал о нём не знает.

### 3. Ручные ключевые кадры — 1.130, наполовину

`MotionNodeMixin.applyManualKeyframeTrack`, `removeManualKeyframeTrack`, `setTimelineDuration`,
все `ManualKeyframeTrack*`, `EffectKeyframe*`, `PaintKeyframeBinding`, `MotionAPI.playheadPosition`.

Мы читаем таймлайны и применяем стили анимации, но **создать** дорожку не можем. Для обещания
«всё ай-кенди один к одному» это дыра ровно посередине.

### 4. Figma Draw — 1.123, наполовину

Переменная ширина обводки (`VariableWidthStrokeProperties`, профили), `transformModifiers` у
`TransformGroupNode`, `textPathStartData`, `setFillsAsync` / `setStrokesAsync`.

### 5. Эффекты 2025 года — 1.111, 1.116

`NoiseEffect` (моно/дуо/мульти), `TextureEffect`, прогрессивное размытие (`startOffset`,
`endOffset`, `startRadius`), `GlassEffect` целиком, `PatternPaint` целиком.

Всё это — вид экрана. Непереведённый шум или стекло — это те самые 10%, которых не видно.

### 6. Диапазоны текста читаются на два поля из пятнадцати — самое дешёвое из всего списка

`text.segments` зовёт `getStyledTextSegments(['boundVariables', 'fills'])` — и всё. Текст, у
которого одно слово другого кегля, со ссылкой, капителью или своим текстовым стилем, читается
как однородный: `runs` мы **пишем**, но обратно они не приходят.

Это прямое нарушение условия остановки, и чинится оно списком полей в одном вызове —
`fontSize`, `fontName`, `fontWeight`, `letterSpacing`, `lineHeight`, `textCase`,
`textDecoration`, `hyperlink`, `textStyleId`, `openTypeFeatures`, `listOptions`,
`indentation`, `textWrapStyle`. Отдельные `getRangeX` из 1.111 при этом не нужны вовсе: они
дают то же самое по одному полю за вызов.

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

## Что считается закрытым

Условие остановки — конъюнкция: пункты 1–7 закрыты **и** любой экран читается через канал так,
что прочитанное можно отправить обратно и получить то же самое. Второе проверяется не глазами:
нужен прогон «прочитать экран → создать по прочитанному → сравнить», и его пока нет.
