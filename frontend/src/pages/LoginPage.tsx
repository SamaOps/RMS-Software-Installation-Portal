import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageOpen } from 'lucide-react';
import { Button } from '../components/ui';
import { api, apiError, session } from '../lib/api';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await api.login(username, password);
      session.set(r.token, r.username);
      navigate('/', { replace: true });
    } catch (err) {
      setError(apiError(err).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
            <PackageOpen className="h-5 w-5" />
          </span>
          <div>
            <h1 className="font-semibold">RMS Software Portal</h1>
            <p className="text-sm text-slate-500">Sign in to manage deployments</p>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="u">Username</label>
            <input id="u" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="p">Password</label>
            <input id="p" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}
          <Button type="submit" loading={loading} className="w-full">
            Sign in
          </Button>
        </div>
      </form>
    </div>
  );
}
