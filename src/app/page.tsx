export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center gap-8 px-6 py-16">
      <header className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight">WELCOME</h1>
        <p className="mt-3 text-lg text-neutral-600">
          Личная визитка для нетворкинга: профиль, QR-код и полезные знакомства.
        </p>
      </header>

      <section className="w-full rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">Фаза 1 — фундамент</h2>
        <ul className="mt-3 list-inside list-disc text-sm text-neutral-700">
          <li>Вход по email-коду (OTP), серверные сессии</li>
          <li>Профиль с публичной карточкой по постоянной ссылке</li>
          <li>Публичный API, vCard и QR-код</li>
        </ul>
      </section>

      <p className="text-sm text-neutral-500">
        Проверка системы: <a className="underline hover:text-neutral-800" href="/api/health">/api/health</a>.
        Личная карточка открывается по ссылке <code className="rounded bg-neutral-100 px-1">/p/&lt;slug&gt;</code>.
      </p>
    </main>
  );
}
