# SIEM Frontend

A Vite, React, and TypeScript console scaffold with placeholder routes for the dashboard, alerts,
investigations, and sign-in.

## Development

```sh
npm install
npm run dev
```

Run `npm run typecheck`, `npm run lint`, and `npm run build` to verify changes. `npm run format`
formats the source and project configuration with Prettier.

## Structure

- `src/app/` contains the router and providers.
- `src/features/` contains dashboard, alert, investigation, and auth routes.
- `src/components/ui/` contains shared interface primitives.
- `src/lib/` contains API, WebSocket, and utility helpers.
- `src/hooks/`, `src/types/`, and `src/store/` contain shared hooks, interfaces, and Zustand state.
