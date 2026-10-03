import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';

// Root App component: mounts the React Router tree defined in router.tsx.
// All real UI lives under RootLayout's nested routes; this component itself
// has no markup of its own beyond handing off to the router.
function App() {
  return <RouterProvider router={router} />;
}

export default App;
