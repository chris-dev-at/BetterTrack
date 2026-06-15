import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { AdminApp } from './admin/AdminApp';
import { UserApp } from './user/UserApp';

/**
 * Top-level routing: the separate admin world under `/admin/*` (its own auth +
 * layout, §6.12) and the normal app everywhere else (§7.2). Each subtree mounts
 * its own AuthProvider, so only one auth-response policy is ever active.
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </BrowserRouter>
  );
}
