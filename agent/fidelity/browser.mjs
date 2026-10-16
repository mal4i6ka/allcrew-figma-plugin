/**
 * The build side of a fidelity run: the page as Chrome renders it at one width — every text block
 * with its box and computed style, and a full-page screenshot.
 *
 * Drives the system Chrome headless over the DevTools protocol, so the run needs no npm packages
 * and renders with the same engine the designers check the sandbox in.
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import { stitch } from './png.mjs'

export const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export async function launch({ port = 9360 } = {}) {
  const userDir = path.join(os.tmpdir(), `allcrew-fidelity-${port}-${process.pid}`)
  await mkdir(userDir, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--force-device-scale-factor=1', '--mute-audio', 'about:blank',
  ], { stdio: 'ignore' })

  let wsUrl
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
    } catch {}
    if (!wsUrl) await sleep(250)
  }
  if (!wsUrl) {
    chrome.kill()
    throw new Error(`Chrome did not expose a debugging target (is it at ${CHROME}?)`)
  }

  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    }
  }
  // Every call has a ceiling: a page that never settles must fail the one capture, not hang the run.
  const send = (method, params = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const n = ++id
    const timer = setTimeout(() => {
      pending.delete(n)
      reject(new Error(`${method} did not answer in ${timeoutMs / 1000}s`))
    }, timeoutMs)
    pending.set(n, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  await send('Page.enable')
  await send('Runtime.enable')
  // Video never loads: the poster is the still the design shows, and once headless Chrome has
  // decoded a WebM every later screenshot in the session stops answering.
  await send('Network.enable')
  await send('Network.setBlockedURLs', { urls: ['*.webm', '*.mp4', '*.mov', '*.m3u8'] })

  async function close() {
    ws.close()
    chrome.kill()
    await rm(userDir, { recursive: true, force: true }).catch(() => {})
  }
  return { send, evaluate, close }
}

/**
 * Collects the page's text blocks. A block is an element whose own children add no block-level
 * text of their own — a heading, a paragraph, a button label — so a sentence with a bold word in
 * it is one block, like the one Figma text layer it came from.
 */
const PROBE = `(() => {
  const norm = s => s.replace(/\\s+/g, ' ').trim();
  const INLINE = new Set(['SPAN','B','STRONG','EM','I','A','SMALL','U','BR','SUP','SUB','MARK','CODE','ABBR','TIME','LABEL']);
  const shown = el => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const hasText = el => norm(el.textContent).length > 0;
  const selector = el => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 5; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(s + '#' + e.id); break; }
      const cls = [...e.classList].filter(c => !/^(swiper-|is-|js-)/.test(c)).slice(0, 3);
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const out = [];
  const isBlock = el => hasText(el) && ![...el.children].some(c => hasText(c) && !INLINE.has(c.tagName));
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','svg'].includes(el.tagName)) continue;
    if (!isBlock(el)) continue;
    // An inline run inside a block is part of that block's text, not a block of its own.
    if (INLINE.has(el.tagName) && el.parentElement && isBlock(el.parentElement)) continue;
    if (!shown(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const g = range.getBoundingClientRect();
    if (!g.width || !g.height) continue;
    // Style comes from the element that holds the glyphs, not from the block: in
    // <li><a class="nav-link">Fees</a></li> the colour is the link's, and reading the li's
    // inherited white reported a grey link as white.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const glyphs = walker.nextNode()?.parentElement ?? el;
    const cs = getComputedStyle(glyphs);
    out.push({
      text: norm(el.innerText || el.textContent),
      x: Math.round(g.x + scrollX), y: Math.round(g.y + scrollY), w: Math.round(g.width), h: Math.round(g.height),
      selector: selector(glyphs),
      style: {
        fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
        fontWeight: Number(cs.fontWeight),
        fontSize: parseFloat(cs.fontSize),
        lineHeight: cs.lineHeight === 'normal' ? null : Math.round(parseFloat(cs.lineHeight) * 100) / 100,
        letterSpacing: cs.letterSpacing === 'normal' ? 0 : Math.round(parseFloat(cs.letterSpacing) * 100) / 100,
        textTransform: cs.textTransform,
        textAlign: cs.textAlign,
        color: cs.color,
      },
    });
  }
  // Form controls show text that is not in the DOM's text: a calculator's "100" and "EUR".
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')) {
    if (!shown(el)) continue;
    const t = norm(el.tagName === 'SELECT' ? (el.selectedOptions[0]?.textContent ?? '') : (el.value || el.placeholder || ''));
    if (!t) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    out.push({
      text: t, input: true,
      x: Math.round(r.x + scrollX + parseFloat(cs.paddingLeft)), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height),
      selector: selector(el),
      style: { fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), fontWeight: Number(cs.fontWeight), fontSize: parseFloat(cs.fontSize),
        lineHeight: cs.lineHeight === 'normal' ? null : Math.round(parseFloat(cs.lineHeight) * 100) / 100,
        letterSpacing: cs.letterSpacing === 'normal' ? 0 : Math.round(parseFloat(cs.letterSpacing) * 100) / 100,
        textTransform: cs.textTransform, textAlign: cs.textAlign, color: cs.color },
    });
  }
  // Pictures, by box: a design text that lands on one was drawn into the image, not set as text.
  const media = [];
  for (const el of document.querySelectorAll('img, picture, svg, canvas, video, [style*="background-image"]')) {
    if (el.closest('picture') && el.tagName !== 'PICTURE') continue;
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 24) continue;
    media.push({ x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height), selector: selector(el) });
  }
  return JSON.stringify({ blocks: out, media, height: document.documentElement.scrollHeight, width: document.documentElement.clientWidth });
})()`

/** Hides what is not part of the design: the consent banner and anything the config names. */
const hideCss = (selectors) => `(() => {
  const s = document.createElement('style');
  s.textContent = ${JSON.stringify(selectors.join(',') || '#__none__')} + '{display:none!important}';
  document.head.appendChild(s);
  return 1;
})()`

/** Load a page at one width, settle it, and read it. */
const trace = (...a) => process.env.FIDELITY_DEBUG && process.stderr.write(`\n  [${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`)

export async function capture(drv, { url, width, height = 900, hide = [], setup, outPng }) {
  trace('navigate', url)
  await drv.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 })
  await drv.send('Page.navigate', { url })
  // Load, then walk to the bottom and back: lazy images, scroll-reveal animations and
  // "load more" sections only exist once they have been in view.
  for (let i = 0; i < 60; i++) {
    if ((await drv.evaluate('document.readyState')) === 'complete') break
    await sleep(250)
  }
  // Put the page into the state its frame shows — a tab picked, a menu open. `click(text)` is
  // there for the common case: the element whose own text is exactly that.
  if (setup) {
    await drv.evaluate(`(async () => {
      const click = (t) => { const el = [...document.querySelectorAll('button, a, [role=tab], label')].find(e => e.textContent.trim() === t && e.offsetParent); if (!el) throw new Error('setup: nothing to click called ' + t); el.click(); };
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      ${setup};
      await wait(400);
      return 1;
    })()`)
    trace('setup done')
  }
  // The site scrolls smoothly; a measured scroll position must not be mid-animation.
  await drv.evaluate(`(document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important'), 1)`)
  trace('loaded; scrolling')
  await drv.evaluate(`(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += ${Math.round(height * 0.8)}) { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 120)); }
    scrollTo({ top: 0, behavior: 'instant' }); await document.fonts.ready; await new Promise(r => setTimeout(r, 600)); return 1;
  })()`)
  trace('scrolled')
  // Freeze after the walk, so reveal-on-scroll has already played. Video is blocked at the
  // network (see launch), so it shows its poster; reloading a <video> here to force that hung the
  // capture on its own.
  await drv.evaluate(`(() => {
    const s = document.createElement('style');
    s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    document.head.appendChild(s);
    document.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('autoplay'); });
    // A cross-origin iframe (an embedded third-party widget) is another site's page, rendered
    // out of process: if it is still painting when capture starts, capture can hang. Its content
    // is not part of this page's design either, so a box of the same size stands in.
    document.querySelectorAll('iframe').forEach(f => {
      const r = f.getBoundingClientRect(); const box = document.createElement('div');
      box.style.cssText = 'width:' + r.width + 'px;height:' + r.height + 'px;background:repeating-linear-gradient(45deg,#8883 0 8px,#8881 8px 16px);border-radius:inherit';
      box.dataset.fidelityIframe = f.src; f.replaceWith(box);
    });
    return 1;
  })()`)
  await drv.evaluate(hideCss(hide))
  const probe = JSON.parse(await drv.evaluate(PROBE))
  trace('probed', probe.blocks.length, 'blocks, height', probe.height)
  if (outPng) {
    await writeFile(outPng, await captureTiles(drv, { width, height, pageHeight: Math.min(probe.height, 16000) }))
    trace('captured')
  }
  return probe
}

/**
 * The whole page as one PNG, without ever changing the viewport.
 *
 * Chrome's own full-page capture lays the page out at its full height, which fires resize: a page
 * that sizes sections from the viewport then grows, resizes again, and its main thread never comes
 * back (the redesign's /business/ did, 9975 → 10071px and counting). So: one viewport-sized shot
 * per scroll step, fixed and sticky elements hidden after the first so the header is drawn once,
 * stitched on a canvas in the page itself.
 */
async function captureTiles(drv, { width, height, pageHeight }) {
  const tiles = []
  for (let y = 0; y < pageHeight; y += height) {
    const at = await drv.evaluate(`(async () => { scrollTo({ top: ${y}, behavior: 'instant' }); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return scrollY })()`)
    const shot = await drv.send('Page.captureScreenshot', { format: 'png' }, 30000)
    tiles.push({ y: at, png: Buffer.from(shot.data, 'base64') })
    trace('tile', tiles.length, 'at', at)
    if (tiles.length === 1) {
      await drv.evaluate(`(() => {
        for (const el of document.querySelectorAll('body *')) {
          const p = getComputedStyle(el).position;
          if (p === 'fixed' || p === 'sticky') el.style.setProperty('visibility', 'hidden', 'important');
        }
        return 1;
      })()`)
    }
  }
  // Stitched here rather than on a canvas in the page: the page's own scripts keep its main
  // thread busy enough that a 14-megapixel toDataURL there never came back.
  return stitch(tiles, width, pageHeight)
}
