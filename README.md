# ai-moves

架构与实施规划见 [docs/architecture-v1.md](docs/architecture-v1.md)。

## 工具链

| 项         | 版本来源                                                     |
| ---------- | ------------------------------------------------------------ |
| Node.js    | `mise.toml`，并由 `package.json` 的 `engines` 约束           |
| pnpm       | `mise.toml` 与 `package.json` 的 `packageManager`            |
| 依赖版本   | `pnpm-workspace.yaml` 的 `catalog`，各包用 `catalog:` 引用   |
| TypeScript | `tooling/tsconfig/`，各包用 project references 相互引用      |
| Lint       | `.oxlintrc.json`，由 `tooling/src/oxlint-config.ts` 生成     |
| 格式化     | `.oxfmtrc.json`                                              |
| 测试       | Vitest，共享预设在 `tooling/vitest/`，测试中全局网络访问被禁 |

```sh
mise install
pnpm install
```

## 常用命令

| 命令                                | 作用                                   |
| ----------------------------------- | -------------------------------------- |
| `pnpm check`                        | 依次执行格式检查、lint、类型检查、测试 |
| `pnpm format` / `pnpm format:check` | 格式化 / 只检查                        |
| `pnpm lint`                         | 全仓 lint（含类型感知规则）            |
| `pnpm typecheck`                    | `tsc -b` 全仓类型检查                  |
| `pnpm test`                         | 全仓测试                               |
| `pnpm --filter <pkg> <script>`      | 单包执行 `lint` / `typecheck` / `test` |
| `pnpm lint:config`                  | 重新生成 `.oxlintrc.json`              |

## 依赖方向

各包允许的 workspace 依赖、平台模块、裸 `fetch` 等能力集中定义在 `tooling/src/boundaries.ts`，与架构文档 3.2、3.3 对应。

- 新增包时先在该文件登记，再执行 `pnpm lint:config`；未登记的包默认不能 import 任何 workspace 包。
- `tooling/lint-proof/fixtures/` 是故意违规的样例，`tooling/test/lint-proof.test.ts` 用仓库的 lint 配置逐个验证它们会失败。
