import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { InventoryPage } from './pages/InventoryPage';
import { HistoryPage } from './pages/HistoryPage';
import { session } from './lib/api';

function RequireAuth({ children }: { children: ReactNode }) {
  return session.token ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<InventoryPage />} />
        <Route path="history" element={<HistoryPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
