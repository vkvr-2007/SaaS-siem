import { AppProviders } from './app/Providers';
import { AppRoutes } from './app/routes';

export default function App() {
  return (
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  );
}
