(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (sel, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (document.querySelector(sel)) return true;
      await sleep(300);
    }
    return false;
  };

  const report = { steps: [] };
  const push = (k, v) => { report.steps.push([k, v]); };

  const gotSessions = await waitFor('.dcu-wb-session', 30000);
  push('sessionsVisible', gotSessions);
  if (!gotSessions) return report;

  // click the session from the user screenshot
  const target = [...document.querySelectorAll('.dcu-wb-session')]
    .find((e) => e.textContent.trim() === '问题原因探究');
  push('targetFound', !!target);
  if (target) target.click();
  await sleep(2500);

  const measure = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      cls: el.className.toString().slice(0, 60),
      rectW: Math.round(r.width), rectH: Math.round(r.height),
      offsetW: el.offsetWidth, clientW: el.clientWidth, scrollW: el.scrollWidth,
      display: cs.display, width: cs.width, minW: cs.minWidth, maxW: cs.maxWidth,
      flex: cs.flex, overflow: cs.overflow, whiteSpace: cs.whiteSpace,
    };
  };

  const q = (sel) => document.querySelector(sel);
  report.inlineTabs = !!q('[data-dcu-inline-tabs]');
  report.chain = {
    crumb: measure(q('.wSkVaW_crumb')),
    crumbs: measure(q('.wSkVaW_crumbs')),
    titleCluster: measure(q('.wSkVaW_titleCluster')),
    titleRow: measure(q('.wSkVaW_titleRow')),
    header: measure(q('.wSkVaW_header')),
  };

  // walk ancestors of header to find the width constraint
  const header = q('.wSkVaW_header');
  const anc = [];
  if (header) {
    let n = header.parentElement;
    let depth = 0;
    while (n && depth < 8) {
      const r = n.getBoundingClientRect();
      anc.push({
        tag: n.tagName, cls: n.className.toString().slice(0, 50),
        rectW: Math.round(r.width),
        flex: getComputedStyle(n).flex,
        display: getComputedStyle(n).display,
      });
      n = n.parentElement; depth++;
    }
  }
  report.ancestors = anc;
  report.viewport = { w: window.innerWidth, h: window.innerHeight };
  return report;
})()
