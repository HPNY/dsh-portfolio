// 测试用的极简 React 桩：只实现 createElement / hooks 的空壳。
//
// 为什么要它：`src/client/table-sort.js` 从 "react" 导入，Node 里没有 react
// 包（真实运行时由宿主 ModuleLoader 提供）。测试时用 esbuild 的 alias 把
// "react" 指到这里，就能把组件函数当普通函数调用、检查它返回的元素树——
// 这比 grep 源码可靠：类名、aria、箭头字符都是真实产物。
export const createElement = (type, props, ...children) => ({
	type,
	props: props ?? {},
	children: children.flat(Infinity).filter((c) => c !== null && c !== void 0 && c !== false),
});
export const useState = (v) => [typeof v === "function" ? v() : v, () => {}];
export const useEffect = () => {};
export const useRef = (v) => ({ current: v });
export const useCallback = (fn) => fn;
export const createRoot = () => ({ render() {}, unmount() {} });
