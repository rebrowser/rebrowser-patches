// Plays an anti-bot script: from the start of the document, samples the global object every 5 ms and lists every
// property that appears after that (so short-lived ones count too). Frame indexes ("0", "1", ...) are ignored.
// The list is kept in <textarea id="__detector"> so a test can read it from any world.
(() => {
  const base = new Set(Object.getOwnPropertyNames(window))
  const added = []
  const scan = () => {
    for (const k of Object.getOwnPropertyNames(window)) {
      if (base.has(k) || added.includes(k) || /^\d+$/.test(k)) continue
      added.push(k)
    }
    const out = document.getElementById('__detector')
    if (out) out.value = JSON.stringify(added)
  }
  setInterval(scan, 5)
})()
