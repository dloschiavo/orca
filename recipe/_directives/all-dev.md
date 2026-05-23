No display-layer transforms:
Data must be clean at extraction/storage time. Never strip, sanitize, or transform data at the render layer. Display-layer transforms mask dirty data from every other consumer (matching, LLM inputs, exports), making bugs invisible. If garbage appears in the UI, fix the extractor — that's the signal, not the reason to hide it.

No React interfaces or serialization:
Except where explicitly instructed otherwise, react components MUST use live objects, not stripped object interfaces. Similarly, never serialize to JSON to cross context into React, or from React component to component. Internal serialization and object interfaces strip prototype methods, getters, and setters, forcing constant manual attribute management that diverges and fails silently as the project grows. It also generates a HUGE amount of wasteful boilerplate.

React + mixed context extension pattern:
When using React in a browser extension, if the project has data extraction code in the window context, then the proper pattern is to use a global factory and object registry. This has the serialization problem above, but also causes you to massively duplicate code. Load the bundle via import() from the content script world so no boundary exists. Then React calls methods on the live item directly.