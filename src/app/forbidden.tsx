import { LinkButton } from "@/components/ui/button";

export default function Forbidden() {
  return (
    <main className="grid min-h-[60dvh] place-items-center p-6 text-center">
      <div>
        <p className="font-mono text-[12px] text-faint">403</p>
        <h1 className="mt-1 text-[18px] font-semibold">You don&apos;t have permission to view this</h1>
        <LinkButton href="/" className="mt-4">
          Go home
        </LinkButton>
      </div>
    </main>
  );
}
