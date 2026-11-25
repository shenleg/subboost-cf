// next/navigation 的浏览器适配，仅提供上游 UI 已使用的 Hooks。
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";

/** 返回 SPA 当前路径，不含查询和片段；需在浏览器路由上下文中使用。 */
export function usePathname() {
  return useLocation().pathname;
}

/** 返回随 SPA 导航更新的查询参数；需在浏览器路由上下文中使用。 */
export function useSearchParams() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

/** 返回压入与替换历史记录的导航方法；需在浏览器路由上下文中使用。 */
export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => ({
    push: (href: string) => void navigate(href),
    replace: (href: string) => void navigate(href, { replace: true }),
  }), [navigate]);
}
