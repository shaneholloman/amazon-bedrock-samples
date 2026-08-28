# src/lambdas/chat/

Handles `POST /chat` — conversational retrieval over the user's documents.

- Calls `AgenticRetrieveStream` with an explicit per-user `equals` filter on `user_id`
- Supports multi-turn context via the `history` parameter (stateless API, client replays turns)
- Supports model selection from the `@bmkb/common` CHAT_MODELS catalog (Auto or a specific model)
- Streams tokens and citations back to the client via Server-Sent Events
