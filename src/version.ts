import pkg from "../package.json" with { type: "json" };

// `bun build --define` が差し込む識別子。release のバイナリは tag と同じ版を名乗り、開発実行
// (定義が無い) は package.json の版を名乗る。process.env にしないのは、利用者の env で版を
// 偽れてしまうため。
declare const __BUILD_VERSION__: string | undefined;

export const VERSION: string =
  typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : pkg.version;
