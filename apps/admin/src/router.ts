import { useEffect, useState } from 'react';

// 极简 hash 路由（ADM-6）：#/page?k=v。不引路由库——四五个平级页面用不上。
export interface Route {
  page: string;
  params: URLSearchParams;
}

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [page, qs] = h.split('?');
  return { page: page || 'dashboard', params: new URLSearchParams(qs ?? '') };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(page: string, params?: Record<string, string>): void {
  const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : '';
  window.location.hash = `#/${page}${qs}`;
}
