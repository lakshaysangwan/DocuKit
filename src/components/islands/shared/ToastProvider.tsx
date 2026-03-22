import { Toaster } from 'sonner';

export default function ToastProvider() {
  return (
    <Toaster
      position="bottom-right"
      expand={false}
      richColors
      closeButton
      toastOptions={{
        duration: 4000,
        classNames: {
          toast: 'font-sans text-sm',
        },
      }}
    />
  );
}
