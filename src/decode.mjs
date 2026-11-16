function document(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料不是对象');
  return value;
}

export function decode(bytes) {
  const value = document(bytes);
  if (!value.request || !Array.isArray(value.events)) throw new Error('没有响应事件');
  const finals = value.events.filter(event => event.status >= 200);
  if (finals.length !== 1) throw new Error('响应终态不唯一');
  return { request: value.request, hints: value.events.filter(event => event.status === 103).map(event => event.headers),
    finalStatus: finals[0].status, finalHeaders: finals[0].headers, body: finals[0].body || null };
}
