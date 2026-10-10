import '@fontsource-variable/manrope';
import '@fontsource-variable/unbounded';
import './styles/base.css';
import './styles/client.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ApiFailure } from './api.ts';
import { ClientApp } from './client/ClientApp.tsx';
import { initTelegram } from './telegram.ts';
import { ToastProvider } from './ui/kit.tsx';

initTelegram();

// Админ-панель грузится отдельным чанком: клиентам её код не нужен.
const AdminApp = lazy(() => import('./admin/AdminApp.tsx'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Ошибки доступа и «не найдено» повторять бессмысленно.
      retry: (count, error) =>
        count < 2 && !(error instanceof ApiFailure && error.status >= 400 && error.status < 500),
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route
              path="/admin/*"
              element={
                <Suspense fallback={null}>
                  <AdminApp />
                </Suspense>
              }
            />
            <Route path="/*" element={<ClientApp />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
