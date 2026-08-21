export function formatDateTime(value: string | null, options: Intl.DateTimeFormatOptions = {}): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '无效时间';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, ...options
  }).format(date);
}

export function relativeTime(value: string | null): string {
  if (!value) return '从未';
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

export function confidenceClass(value: number | null): 'high' | 'medium' | 'low' {
  return (value ?? 0) >= 75 ? 'high' : (value ?? 0) >= 45 ? 'medium' : 'low';
}

export function sourceLabel(source: string | null): string {
  return ({ manual: '人工', dynamic: '明确动态', weekly_schedule: '周表', pi: 'Pi 推测', fallback: '系统顺延' } as Record<string, string>)[source ?? ''] ?? '待分析';
}

export function richTextHtml(text: string, emojiMap: Record<string, string> = {}): string {
  const escaped = text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
  return escaped.replace(/\[[^\]\r\n]+\]/g, (token) => {
    const url = emojiMap[token];
    return url && /^https:\/\//.test(url)
      ? `<img class="inline-emoji" src="${url}" alt="${token}" title="${token}" loading="lazy">`
      : token;
  });
}
