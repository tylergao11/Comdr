# Python 编码约定

## 环境与包管理

- Python 3.11+。用 `pyproject.toml` 管理项目元数据和依赖。
- 虚拟环境: `python -m venv .venv`。激活后 pip install。
- 包管理: poetry 或 pip-tools。锁定文件必须提交。

## 类型

- 所有公开函数必须有类型注解（PEP 484）。
- `mypy --strict` 或 `pyright` 检查类型。
- `Protocol` 用于结构化子类型。`TypedDict` 用于字典类型。
- 禁止 `Any` — 用 `object` 或具体泛型。

## 测试

- 测试框架: pytest。测试文件命名 `test_*.py`。
- 覆盖率: `pytest --cov`。
- fixtures 优于 setUp/tearDown。
- parametrize 用于同一逻辑的多组输入。

## 风格

- Black 或 ruff format 自动格式化。
- ruff 或 flake8 + isort 做 lint + import 排序。
- 函数体不超过 50 行。类不超过 300 行。

## 异步

- `asyncio` 用于 I/O 密集型。`async`/`await` 语法。
- `asyncio.gather` 并发多个协程。
- CPU 密集型任务用 `concurrent.futures.ProcessPoolExecutor`。

## 常见错误

- 默认参数用可变对象 → 状态泄漏。用 `None` + 内部初始化。
- `except Exception` 太宽 → 用具体异常类型。
- `import *` 污染命名空间。
- 循环导入 → 提取共享接口或延迟导入。
