import { Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Spinner, ToastProvider } from './components/ui';
import Layout from './components/Layout';
import { Login, Setup } from './pages/Auth';
import { AddPage, RecordPage } from './pages/Create';
import PromptsPage from './pages/Prompts';
import { Dashboard, People, Person, Search, Stories, Timeline } from './pages/Browse';
import MemoryDetail from './pages/MemoryDetail';
import { Family, Help, Settings } from './pages/Manage';
import type { Persona } from './types';

const HOME: Record<Persona, string> = { elder: '/record', archivist: '/dashboard', explorer: '/timeline' };

function Protected() {
  const { user, config, loading } = useAuth();
  if (loading) return <Spinner label="Opening your vault…" />;
  if (!user) return <Navigate to={config && !config.initialized ? '/setup' : '/login'} replace />;
  return <Layout />;
}

function Home() {
  const { user, config, loading } = useAuth();
  if (loading) return <Spinner label="Opening your vault…" />;
  if (!user) return <Navigate to={config && !config.initialized ? '/setup' : '/login'} replace />;
  return <Navigate to={HOME[user.persona]} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/setup" element={<Setup />} />
              <Route element={<Protected />}>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/record" element={<RecordPage />} />
                <Route path="/add" element={<AddPage />} />
                <Route path="/prompts" element={<PromptsPage />} />
                <Route path="/stories" element={<Stories />} />
                <Route path="/timeline" element={<Timeline />} />
                <Route path="/search" element={<Search />} />
                <Route path="/people" element={<People />} />
                <Route path="/person/:name" element={<Person />} />
                <Route path="/memory/:id" element={<MemoryDetail />} />
                <Route path="/family" element={<Family />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/help" element={<Help />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
