#!/bin/zsh
# Deploy the built plugin to the volume Figma actually loads from, and PROVE it landed.
# The pair is the unit: a code.js from one build beside a ui.html from another loads a UI
# that calls into code that does not know it — both files intact, nothing to blame on the
# mount. rsync's exit code is not evidence; md5 on both sides is.
L="$HOME/altery-figma-ds"
V=/Volumes/5D53821A-6951-404C-9E39-C111A9C3BBAD/altery-figma-ds
[[ -d "$V" ]] || { echo "том не смонтирован"; exit 1 }

verify() {
  for f in dist/code.js dist/ui.html; do
    [[ "$(md5 -q "$L/$f")" == "$(md5 -q "$V/$f" 2>/dev/null)" ]] || return 1
  done
  return 0
}

tries=0
while (( tries < 40 )); do
  (( tries++ ))
  rsync -a --partial --timeout=25 "$L/dist/code.js" "$L/dist/ui.html" "$V/dist/" 2>/dev/null
  if verify; then
    echo "$(date +%H:%M:%S) пара доставлена и сверена (попытка $tries)"
    md5 -q "$V/dist/code.js" | sed 's/^/  code.js  /'
    md5 -q "$V/dist/ui.html" | sed 's/^/  ui.html  /'
    # огрызки прерванных переносов — следы смертей монтирования
    n=$(ls "$V/dist/" | grep -cE '^\._|\.[0-9A-Za-z]{6}$')
    (( n > 0 )) && { echo "  чищу $n временных"; find "$V/dist" -maxdepth 1 \( -name '._*' -o -name '*.??????' \) -delete 2>/dev/null }
    # Figma перечитывает код плагина сама: за один день три деплоя подряд стали живыми
    # без переоткрытия. Просить рестарт по умолчанию — это тратить время дизайнера на
    # обряд; проверка одним вызовом отвечает на тот же вопрос и не врёт, когда рестарт
    # всё-таки нужен.
    echo "  → проверь одним вызовом новой операции; если ответит 'unknown op' — тогда переоткрой плагин"
    exit 0
  fi
  echo "$(date +%H:%M:%S) попытка $tries: пара ещё не сошлась, жду 20с"
  sleep 20
done
echo "СДАЛСЯ: пара не сошлась за 40 попыток"; exit 1
