# ViolinVention API

Backend for ViolinVention built with Node.js/Express, Supabase authentication/DB, and OpenAI Responses API for chat. It also proxies PDF generation and manages user-specific vector stores.

## Quick Start

```bash
# Install (npm is recommended because package-lock.json is present)
npm install
# or
yarn install

# Copy envs and fill in your secrets
cp .env.example .env
# then set Supabase + OpenAI keys (see below)

# Development
npm run dev

# Production
npm start
```

Swagger docs are available in development at `http://localhost:<PORT>/v1/docs`.

## Table of Contents
- Features
- Commands
- Environment Variables
- Project Structure
- API Overview
- Authentication & Authorization
- Error Handling
- Validation
- Logging
- Testing
- License

## Features
- Supabase-backed auth/authorization and persistence for chats/messages/vector-store metadata.
- Chat + messaging flows powered by OpenAI Responses API with conversation memory.
- Per-user vector stores for lesson summaries/transcripts with upload, delete, and search.
- PDF proxy endpoint that forwards HTML to an internal PDF service.
- Lesson recording processing endpoint (single structured summarization that returns summary, student, title, pieces, themes).
- Auto-generated Swagger docs (development only).

## Commands
- `npm run dev` – start with nodemon (`NODE_ENV=development`).
- `npm start` – start with Node (`NODE_ENV` from env, defaults to production in `ecosystem.config.json`).
- `npm run lint` / `npm run lint:fix` – ESLint.
- `npm run prettier` / `npm run prettier:fix` – Prettier.
- `npm test` – Node’s built-in test runner (`node --test`).

## Environment Variables
Defined via Joi in `src/config/config.js`. Key ones:

```bash
PORT=4000                # default: 8080 in code
NODE_ENV=development     # development | production | test

# Supabase (service key recommended for backend verification)
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_KEY=<service-role-key>
# Optional fallback (not recommended for prod)
SUPABASE_ANON_KEY=<anon-key>

# OpenAI main client (required)
OPENAI_API_KEY=sk-...
OPENAI_API_MODEL=gpt-5  # e.g., gpt-4o, gpt-5, etc.
OPENAI_PROJECT_ID=proj_...   # required for project-scoped keys

# Bot client (optional; falls back to main client if omitted)
OPENAI_API_KEY_BOT=
OPENAI_API_MODEL_BOT=
OPENAI_PROJECT_ID_BOT=

# Prompt IDs/versions/instructions (optional overrides; defaults baked into config)
PROMPT_ID=
PROMPT_VERSION=
PROMPT_INSTRUCTIONS=
PROMPT_ID_PERSONAL_LESSONS=
PROMPT_VERSION_PERSONAL_LESSONS=
PROMPT_INSTRUCTIONS_PERSONAL_LESSONS=
PROMPT_ID_PERSONAL_LESSONS_DEEPDIVE=
PROMPT_VERSION_PERSONAL_LESSONS_DEEPDIVE=
PROMPT_INSTRUCTIONS_PERSONAL_LESSONS_DEEPDIVE=
PROMPT_ID_LESSON_PLAN=
PROMPT_VERSION_LESSON_PLAN=
PROMPT_INSTRUCTIONS_LESSON_PLAN=
PROMPT_ID_DEEPTHINK=
PROMPT_VERSION_DEEPTHINK=
PROMPT_INSTRUCTIONS_DEEPTHINK=
PROMPT_ID_BOT=
PROMPT_VERSION_BOT=

# Conversation memory tuning (all optional; defaults set in config)
MEMORY_K_RAW_TURNS=3
MEMORY_SUMMARY_TOKEN_CAP=500
MEMORY_PROMPT_TOKEN_BUDGET=3000
MEMORY_CHUNK_SUMMARIZE_THRESHOLD=6000
MEMORY_SUMMARIZER_MODEL=gpt-5.1-nano
PROMPT_ID_SUMMARY_GLOBAL=
PROMPT_VERSION_SUMMARY_GLOBAL=

# PDF service
PDF_SERVICE_URL=http://localhost:3001
```

Note: Legacy JWT/SMTP vars in `.env.example` are unused; Supabase bearer tokens are required instead.

## Project Structure
```
src/
  app.js              Express setup (security, logging, routing, errors)
  index.js            Server entry
  config/             env validation, logger, morgan, roles, Supabase/OpenAI config
  controllers/        Route handlers (chat, message, vector store, recording)
  services/           Core business logic (OpenAI, Supabase, vector store, memory)
  routes/v1/          Versioned routes
  middlewares/        Supabase auth, validation, error handling
  validations/        Joi schemas
  prompts/            Prompt assets
  docs/               Swagger definition and design docs
database/              SQL migrations
pdf-service/           Separate PDF worker (Node service)
test/                  Node test files and helpers
```

## API Overview
All routes are prefixed with `/v1` and expect a Supabase bearer token unless noted.

- `GET /v1/health` – health check.
- `POST /v1/chat` – create chat (supports `chat_mode`).
- `GET /v1/chat` – list chats.
- `PATCH /v1/chat/:chatId` – update chat title/mode.
- `DELETE /v1/chat/:chatId` – soft-delete chat.
- `POST /v1/message` – send message in a chat (streams OpenAI response).
- `POST /v1/message/first` – create chat + first message with special handling for prep digests/lesson plans.
- `GET /v1/message/:chatId` – list messages in a chat.
- `POST /v1/vector_store/upload` – upload lesson summary/transcript to user’s vector store.
- `DELETE /v1/vector_store/delete` – remove lesson from vector store and OpenAI Files.
- `POST /v1/vector_store/search` – search a user’s vector store (debug/testing).
- `POST /v1/pdf/generate` – proxy HTML→PDF to internal PDF service.
- `GET /v1/pdf/health` – PDF service health.
- `POST /v1/recordings/process` – process lesson recording transcript (summary/tagging).
- `GET /v1/docs` – Swagger UI (development only).

Swagger `components.yml` defines `bearerAuth` (JWT-formatted Supabase tokens). Route comments in `src/routes/v1/*.js` provide additional schema examples.

## Authentication & Authorization
- Auth: Supabase JWT bearer tokens verified via `supabase.auth.getUser` in `src/middlewares/supabaseAuth.js`.
- Roles/rights: Defined in `src/config/roles.js`. Default `user` role includes chat/message/vector-store/recording permissions; `admin` adds user management rights (not currently routed).
- Attachments: `req.user` is populated with Supabase user metadata and checked against required rights per route.

## Error Handling
Centralized error handling with `ApiError`, `errorConverter`, and `errorHandler` (`src/middlewares/error.js`). Errors return `{ code, message }`; stack traces are included only in development.

## Validation
Joi schemas in `src/validations` enforced via `middlewares/validate.js` for params, query, and body payloads.

## Logging
Winston logger (`src/config/logger.js`) with morgan HTTP logging (`src/config/morgan.js`). Log level is `debug` in development, `info` in production.

## Testing
`npm test` runs Node’s built-in test runner (`node --test`) against files in `test/`. Helpers/mocks in `test/setup.js`.

## License
package.json declares MIT; add a `LICENSE` file if you want the full text included.
