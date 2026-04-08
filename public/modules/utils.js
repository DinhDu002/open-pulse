// Shared frontend utilities

export function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function confColor(c) {
  return c < 0.3 ? '#e17055' : c < 0.6 ? '#fdcb6e' : '#00b894';
}

export function confLabel(c) {
  return c < 0.3 ? 'Low' : c < 0.6 ? 'Medium' : 'High';
}

export function confidenceBarHtml(conf) {
  var color = confColor(conf);
  var pct = Math.round(conf * 100);
  return (
    '<span class="confidence-bar">' +
      '<span class="fill" style="display:block;width:' + pct + '%;height:100%;' +
        'background:' + color + ';border-radius:4px;"></span>' +
    '</span>'
  );
}

export function fmtDate(ts) {
  if (!ts) return '\u2014';
  return dayjs(ts).format('MMM D, YYYY HH:mm');
}

export function fmtDateShort(ts) {
  if (!ts) return '';
  return dayjs(ts).format('MMM D');
}

export function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len) + '\u2026';
}

export function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
