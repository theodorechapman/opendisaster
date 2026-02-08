import { useState, useRef } from "react";
import { motion } from "framer-motion";
import { MapPin, Flame, CloudLightning, Mountain, Waves, Rocket, Search, Users } from "lucide-react";
import { DitherCityBackground } from "./DitherCity.tsx";
import { cn } from "./cn.ts";

export type LoadingStep = {
  label: string;
  status: "pending" | "active" | "done" | "error";
};

interface LandingOverlayProps {
  onLookup: (address: string) => Promise<{ lat: number; lon: number } | { error: string }>;
  onLaunch: (lat: number, lon: number, size: number, scenario: string, enableAgents: boolean) => void;
  defaultLat: number;
  defaultLon: number;
}

const SCENARIOS = [
  { id: "fire", name: "Fire", icon: Flame, color: "text-orange-400", available: true },
  { id: "tornado", name: "Tornado", icon: CloudLightning, color: "text-purple-400", available: true },
  { id: "earthquake", name: "Earthquake", icon: Mountain, color: "text-yellow-400", available: true },
  { id: "flood", name: "Flood", icon: Waves, color: "text-blue-400", available: true },
];

const STORAGE_KEY = "opendisaster-landing";

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveState(vals: Record<string, unknown>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(vals)); } catch {}
}

// Global ref so main.ts can push loading updates into React
let _setLoadingStepsGlobal: ((steps: LoadingStep[]) => void) | null = null;

export function updateLoadingSteps(steps: LoadingStep[]) {
  _setLoadingStepsGlobal?.(steps);
}

export function LandingOverlay({ onLookup, onLaunch, defaultLat, defaultLon }: LandingOverlayProps) {
  const saved = useRef(loadSaved()).current;
  const [lat, setLat] = useState(saved?.lat ?? defaultLat.toString());
  const [lon, setLon] = useState(saved?.lon ?? defaultLon.toString());
  const [size, setSize] = useState(saved?.size ?? 500);
  const [address, setAddress] = useState(saved?.address ?? "");
  const [lookupError, setLookupError] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState(saved?.scenario ?? "fire");
  const [enableAgents, setEnableAgents] = useState(saved?.enableAgents ?? true);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingSteps, setLoadingSteps] = useState<LoadingStep[]>([]);
  const addressRef = useRef<HTMLInputElement>(null);

  // Register global setter for loading steps
  _setLoadingStepsGlobal = (steps: LoadingStep[]) => {
    setLoadingSteps(steps);
  };

  async function handleLookup() {
    if (!address.trim()) return;
    setLookupError("");
    setLookupLoading(true);
    try {
      const result = await onLookup(address);
      if ("error" in result) {
        setLookupError(result.error);
      } else {
        setLat(result.lat.toString());
        setLon(result.lon.toString());
      }
    } catch {
      setLookupError("Network error");
    } finally {
      setLookupLoading(false);
    }
  }

  function handleLaunch() {
    const la = parseFloat(lat);
    const lo = parseFloat(lon);
    if (isNaN(la) || isNaN(lo)) return;
    saveState({ lat, lon, size, address, scenario: selectedScenario, enableAgents });
    setIsLoading(true);
    onLaunch(la, lo, size, selectedScenario, enableAgents);
  }

  if (isLoading) {
    const doneCount = loadingSteps.filter(s => s.status === "done").length;
    const totalCount = loadingSteps.length || 1;
    const activeStep = loadingSteps.find(s => s.status === "active");
    const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;

    return (
      <div className="fixed inset-0 z-[10] flex items-center justify-center" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
        <DitherCityBackground />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className={cn(
            "relative z-[1] flex flex-col items-center gap-6 p-8 max-w-[500px] w-[90%]",
            "rounded-2xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-xl"
          )}
        >
          <h1 className="text-2xl font-bold text-white tracking-tight">Loading</h1>

          {/* Progress bar */}
          <div className="w-full h-1.5 bg-white/[0.08] rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-white rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            />
          </div>

          {/* Step list */}
          <div className="w-full space-y-2">
            {loadingSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <div className={cn(
                  "w-1.5 h-1.5 rounded-full shrink-0",
                  step.status === "done" && "bg-green-400",
                  step.status === "active" && "bg-white animate-pulse",
                  step.status === "pending" && "bg-white/20",
                  step.status === "error" && "bg-red-400",
                )} />
                <span className={cn(
                  step.status === "done" && "text-neutral-500",
                  step.status === "active" && "text-white",
                  step.status === "pending" && "text-neutral-600",
                  step.status === "error" && "text-red-400",
                )}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>

          {activeStep && (
            <p className="text-xs text-neutral-500">{activeStep.label}...</p>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[10] flex items-center justify-center" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
      <DitherCityBackground />

      {/* Glassmorphism container */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="relative z-[1] flex flex-col lg:flex-row items-stretch gap-6 p-8 max-w-[1100px] w-[95%]"
      >
        {/* Title row on mobile, hidden on lg */}
        <div className="lg:hidden text-center mb-2">
          <h1 className="text-3xl font-bold text-white tracking-tight">OpenDisaster</h1>
          <p className="text-sm text-neutral-500 mt-1">3D Disaster Simulation Platform</p>
        </div>

        {/* LEFT — Location */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.15, duration: 0.5 }}
          className={cn(
            "flex-1 rounded-2xl p-6",
            "bg-white/[0.04] border border-white/[0.08]",
            "backdrop-blur-xl"
          )}
        >
          <div className="flex items-center gap-2 mb-4">
            <MapPin className="w-4 h-4 text-neutral-400" />
            <span className="text-xs uppercase tracking-widest text-neutral-400 font-medium">Location</span>
          </div>

          {/* Address lookup */}
          <div className="flex gap-2 mb-3">
            <input
              ref={addressRef}
              value={address}
              onChange={e => setAddress(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleLookup()}
              placeholder="Address or Google Maps link"
              className={cn(
                "flex-1 bg-white/[0.06] border border-white/[0.1] rounded-lg",
                "px-3 py-2 text-sm text-white placeholder:text-neutral-600",
                "outline-none focus:border-white/[0.25] transition-colors"
              )}
            />
            <button
              onClick={handleLookup}
              disabled={lookupLoading}
              className={cn(
                "px-3 py-2 rounded-lg text-sm font-medium transition-all",
                "bg-white/[0.08] border border-white/[0.1] text-neutral-300",
                "hover:bg-white/[0.14] hover:text-white",
                "disabled:opacity-40"
              )}
            >
              {lookupLoading ? "..." : <Search className="w-4 h-4" />}
            </button>
          </div>
          {lookupError && <p className="text-red-400 text-xs mb-2">{lookupError}</p>}

          {/* Lat/Lon */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label className="text-[11px] text-neutral-500 mb-1 block">Latitude</label>
              <input
                value={lat}
                onChange={e => setLat(e.target.value)}
                type="number"
                step="any"
                className={cn(
                  "w-full bg-white/[0.06] border border-white/[0.1] rounded-lg",
                  "px-3 py-2 text-sm text-white",
                  "outline-none focus:border-white/[0.25] transition-colors"
                )}
              />
            </div>
            <div>
              <label className="text-[11px] text-neutral-500 mb-1 block">Longitude</label>
              <input
                value={lon}
                onChange={e => setLon(e.target.value)}
                type="number"
                step="any"
                className={cn(
                  "w-full bg-white/[0.06] border border-white/[0.1] rounded-lg",
                  "px-3 py-2 text-sm text-white",
                  "outline-none focus:border-white/[0.25] transition-colors"
                )}
              />
            </div>
          </div>

          {/* Size slider */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-500">Area Size</label>
              <span className="text-[11px] text-white font-mono">{size}m</span>
            </div>
            <input
              type="range"
              min={100}
              max={2000}
              step={50}
              value={size}
              onChange={e => setSize(parseInt(e.target.value))}
              className="w-full accent-white h-1 cursor-pointer"
            />
          </div>
        </motion.div>

        {/* CENTER — Disaster Selection */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.5 }}
          className={cn(
            "flex-1 rounded-2xl p-6",
            "bg-white/[0.04] border border-white/[0.08]",
            "backdrop-blur-xl"
          )}
        >
          {/* Desktop title */}
          <div className="hidden lg:block text-center mb-5">
            <h1 className="text-2xl font-bold text-white tracking-tight">OpenDisaster</h1>
            <p className="text-[11px] text-neutral-500 mt-0.5">3D Disaster Simulation</p>
          </div>

          <div className="flex items-center gap-2 mb-4 lg:mt-0">
            <Flame className="w-4 h-4 text-neutral-400" />
            <span className="text-xs uppercase tracking-widest text-neutral-400 font-medium">Disaster</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {SCENARIOS.map(s => {
              const Icon = s.icon;
              const selected = selectedScenario === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => s.available && setSelectedScenario(s.id)}
                  disabled={!s.available}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2.5 rounded-xl text-left transition-all text-sm",
                    "border",
                    selected
                      ? "bg-white/[0.12] border-white/[0.25] text-white"
                      : "bg-white/[0.03] border-white/[0.06] text-neutral-400 hover:bg-white/[0.07] hover:text-neutral-200",
                    !s.available && "opacity-30 cursor-not-allowed"
                  )}
                >
                  <Icon className={cn("w-4 h-4", selected ? s.color : "text-neutral-500")} />
                  <span className="font-medium">{s.name}</span>
                </button>
              );
            })}
          </div>
        </motion.div>

        {/* RIGHT — Launch */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.35, duration: 0.5 }}
          className={cn(
            "flex flex-col items-center justify-center rounded-2xl p-6 min-w-[160px]",
            "bg-white/[0.04] border border-white/[0.08]",
            "backdrop-blur-xl"
          )}
        >
          {/* Agents toggle */}
          <button
            onClick={() => setEnableAgents(!enableAgents)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-all mb-5 w-full justify-center",
              "border",
              enableAgents
                ? "bg-white/[0.1] border-white/[0.2] text-white"
                : "bg-white/[0.03] border-white/[0.06] text-neutral-500"
            )}
          >
            <Users className={cn("w-4 h-4", enableAgents ? "text-green-400" : "text-neutral-600")} />
            <span>Agents {enableAgents ? "On" : "Off"}</span>
          </button>

          <button
            onClick={handleLaunch}
            className={cn(
              "group flex items-center gap-3 px-8 py-4 rounded-full",
              "bg-white text-black font-semibold text-base",
              "hover:bg-neutral-200 active:scale-[0.97]",
              "transition-all duration-200 shadow-lg shadow-white/[0.1]"
            )}
          >
            <Rocket className="w-5 h-5 group-hover:rotate-12 transition-transform" />
            Launch
          </button>
          <p className="text-[11px] text-neutral-600 mt-3 text-center">
            {size}m &times; {size}m area
          </p>
        </motion.div>
      </motion.div>
    </div>
  );
}
