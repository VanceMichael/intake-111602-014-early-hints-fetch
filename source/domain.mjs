export function dispatch({ url, phase }) {
  if (url.pathname === '/exchange/page-2') return { json: { request: 'page-2', events: [
    { status: 103, headers: { link: '</assets/logo>; rel=preload; as=image' } },
    { status: 200, headers: { 'content-type': 'text/html', etag: 'page-b' }, body: '<html><img src="/assets/logo"></html>' } ] } };
  if (url.pathname === '/exchange/cancelled') return { json: { request: 'cancelled', events: [
    { status: 103, headers: { link: '</assets/logo>; rel=preload; as=image' } },
    { status: 503, headers: { 'retry-after': '30' } } ] } };
  return null;
}
