# Rust 编码约定

## 项目结构

- `Cargo.toml` — 包元数据和依赖。`Cargo.lock` 必须提交（application）。
- `src/lib.rs` — 库根。`src/main.rs` — 二进制入口。
- 模块: `mod` 声明。`pub` 控制可见性。`use` 组织导入。

## 类型系统

- 优先 sum type（enum）建模状态。`Option<T>` 而非 null。`Result<T, E>` 而非异常。
- `match` 穷尽所有分支——编译器强制。
- 泛型 + trait bound 实现多态。不用 dyn Trait 除非需要类型擦除。
- `impl Trait` 用于返回值（不暴露具体类型）。

## 所有权

- 默认 move 语义。`Clone` 显式复制。`Copy` 用于简单值类型。
- `&T` 共享引用（不可变）。`&mut T` 独占引用（可变）。同一作用域不能同时存在。
- 生命周期: 尽量让编译器推导。显式标注仅在必要时。

## 错误处理

- `Result<T, E>` + `?` 运算符传播错误。
- `thiserror` 用于自定义错误类型。`anyhow` 用于应用程序级错误。
- 不滥用 `unwrap()` / `expect()`——仅在明确不可能失败时使用。

## 并发

- `std::thread` 用于 CPU 并行。`Arc<Mutex<T>>` 共享可变状态。
- `async`/`await` + tokio 用于 I/O 并发。
- `tokio::spawn` 启动异步任务。`JoinHandle` 等待完成。
- `Send` + `Sync` trait 自动保证线程安全。

## 常见错误

- 借用检查器报错 → 缩小借用范围或 clone。
- `unwrap()` panic → 生产代码用 `?` 或 `match`。
- 忘记 `#[derive(Debug, Clone)]` → 打印或克隆时编译报错。
- Cargo.toml 中 features 不一致 → 使用 `cargo check --all-features`。
