import { Aperture } from "lucide-react";
import { BRAND } from "@/config/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <Aperture size={20} className="text-accent" aria-hidden />
          {BRAND.name}
        </div>
        {children}
      </div>
    </main>
  );
}
