#!/bin/zsh
# Deploy the built plugin to the volume Figma actually loads from, and PROVE it landed.
# The pair is the unit: a code.js from one build beside a ui.html from another loads a UI
# that calls into code that does not know it — both files intact, nothing to blame on the
# mount. rsync's exit code is not evidence; md5 on both sides is.
L="$HOME/allcrew-channel"
V=/Volumes/5D53821A-6951-404C-9E39-C111A9C3BBAD/allcrew-channel
[[ -d "$V" ]] || { echo "том не смонтирован"; exit 1 }

verify() {
  for f in dist/code.js dist/ui.html; do
    [[ "$(md5 -q "$L/$f")" == "$(md5 -q "$V/$f" 2>/dev/null)" ]] || return 1
  done
  return 0
}

# Снимок session id ДО доставки: если после успешного вызова новой операции он тот же,
# рантайм перечитал код в живой сессии; если сменился — нам просто повезло на ротацию.
sids() {
  local s
  s=$(curl -s -m 5 http://127.0.0.1:8788/status -H "x-allcrew-channel-secret: $(cat ~/.allcrew-channel/agent-secret 2>/dev/null)" 2>/dev/null \
      | grep -o '"session":"[^"]*"' | cut -d'"' -f4 | paste -sd' ' -)
  [[ -n "$s" ]] && print -r -- "$s" || print -r -- "(мост недоступен)"
}
sid_before=$(sids)

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
    # Наблюдение, а не механизм: три деплоя подряд отвечали новым поведением через
    # секунды после доставки, и переоткрывать плагин не требовалось ни разу. ПОЧЕМУ —
    # не установлено: сессия плагина иногда сменяется сама, без всякого деплоя, поэтому
    # «ответил сразу» не доказывает, что рантайм перечитал код в живой сессии. Отсюда
    # session id ниже: он отличает одно от другого на реальных деплоях.
    echo "  сессии до доставки:  $sid_before"
    echo "  сессии после:        $(sids)"
    echo "  → проверь одним вызовом новой операции; если ответит 'unknown op' — тогда переоткрой плагин."
    echo "    Тот же session id + новое поведение = рантайм перечитал код; сменившийся id = вывода нет."
    exit 0
  fi
  echo "$(date +%H:%M:%S) попытка $tries: пара ещё не сошлась, жду 20с"
  sleep 20
done
echo "СДАЛСЯ: пара не сошлась за 40 попыток"; exit 1
