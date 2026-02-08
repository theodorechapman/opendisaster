import type { SimulationStatsData } from "./SimulationStats.ts";
import type { HeatmapOverlay } from "./HeatmapOverlay.ts";

export class StatsOverlay {
  private container: HTMLDivElement;
  private style: HTMLStyleElement;

  constructor() {
    this.style = document.createElement("style");
    this.style.textContent = `
      .sim-report {
        position: fixed; inset: 0;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.8);
        z-index: 50;
        font-family: system-ui, sans-serif;
        transition: background 0.3s;
      }
      .sim-report.heatmap-active {
        background: transparent;
        pointer-events: none;
        inset: auto;
        top: 16px; left: 16px;
        width: auto; height: auto;
      }
      .sim-report-inner {
        background: rgba(26,26,46,0.96);
        border: 1px solid #444;
        border-radius: 12px;
        padding: 28px 32px;
        max-width: 680px; width: 92%;
        max-height: 85vh; overflow-y: auto;
        backdrop-filter: blur(12px);
        color: #ddd;
        transition: max-width 0.3s, padding 0.3s;
      }
      .sim-report.heatmap-active .sim-report-inner {
        pointer-events: auto;
        max-width: 280px; width: 280px;
        padding: 14px 16px;
        max-height: 70vh;
      }
      .sim-report h2 {
        font-size: 18px; color: #4fc3f7; margin: 0 0 16px;
        font-family: monospace; letter-spacing: 1px;
        text-transform: uppercase;
      }
      .sim-report.heatmap-active h2 { font-size: 14px; margin-bottom: 10px; }
      .sim-cards {
        display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px;
      }
      .sim-report.heatmap-active .sim-cards { display: none; }
      .sim-card {
        flex: 1; min-width: 100px;
        background: rgba(255,255,255,0.05);
        border: 1px solid #333; border-radius: 8px;
        padding: 10px 12px; text-align: center;
      }
      .sim-card .val { font-size: 22px; font-weight: 700; color: #fff; }
      .sim-card .label { font-size: 10px; color: #888; text-transform: uppercase; margin-top: 2px; }
      .sim-table {
        width: 100%; border-collapse: collapse; font-size: 12px; font-family: monospace;
        margin-bottom: 16px;
      }
      .sim-report.heatmap-active .sim-table { display: none; }
      .sim-table th {
        text-align: left; padding: 6px 8px;
        border-bottom: 1px solid #444; color: #888; font-weight: 600;
      }
      .sim-table td {
        padding: 5px 8px; border-bottom: 1px solid #222;
      }
      .sim-table .alive { color: #66bb6a; }
      .sim-table .dead { color: #ef5350; }
      .sim-heatmap-btns {
        display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px;
      }
      .sim-heatmap-btns button {
        padding: 6px 14px; border: 1px solid #444; border-radius: 6px;
        background: rgba(255,255,255,0.05); color: #ccc;
        font-size: 12px; font-family: monospace; cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .sim-heatmap-btns button:hover { background: rgba(67,97,238,0.15); border-color: #4361ee; }
      .sim-heatmap-btns button.active { background: rgba(67,97,238,0.3); border-color: #4fc3f7; color: #fff; }
      .sim-close-btn {
        width: 100%; padding: 8px;
        background: rgba(46,26,26,0.85); border: 1px solid #622;
        border-radius: 6px; color: #e55;
        font-size: 13px; font-family: monospace; cursor: pointer;
        transition: background 0.15s;
      }
      .sim-close-btn:hover { background: rgba(80,30,30,0.9); border-color: #e55; }
      .sim-show-report-btn {
        width: 100%; padding: 6px;
        background: rgba(255,255,255,0.05); border: 1px solid #444;
        border-radius: 6px; color: #4fc3f7;
        font-size: 11px; font-family: monospace; cursor: pointer;
        margin-top: 6px; display: none;
        transition: background 0.15s;
      }
      .sim-show-report-btn:hover { background: rgba(67,97,238,0.15); border-color: #4361ee; }
      .sim-report.heatmap-active .sim-show-report-btn { display: block; }
      .sim-report.heatmap-active .sim-close-btn { display: none; }
    `;
    document.head.appendChild(this.style);

    this.container = document.createElement("div");
    this.container.className = "sim-report";
    this.container.style.display = "none";
    document.body.appendChild(this.container);
  }

  show(stats: SimulationStatsData, heatmapOverlay: HeatmapOverlay): void {
    const causeLabel = (cause: string | null): string => {
      if (!cause) return "-";
      const map: Record<string, string> = {
        FIRE_SPREAD: "Fire",
        FLOOD_LEVEL: "Flooding",
        WIND_FIELD_UPDATE: "Tornado Wind",
        WIND_DEBRIS: "Tornado Debris",
        GROUND_SHAKE: "Earthquake",
        QUAKE_DEBRIS: "Quake Debris",
        STRUCTURE_COLLAPSE: "Building Collapse",
      };
      return map[cause] ?? cause;
    };

    const agentRows = stats.agentRecords
      .map(
        (a) =>
          `<tr>
            <td>${a.name}</td>
            <td class="${a.alive ? "alive" : "dead"}">${a.alive ? "Alive" : "Dead"}</td>
            <td>${a.timeOfDeath !== null ? a.timeOfDeath.toFixed(0) + "s" : "-"}</td>
            <td>${causeLabel(a.cause)}</td>
            <td>${a.totalDamage.toFixed(1)}</td>
          </tr>`,
      )
      .join("");

    this.container.innerHTML = `
      <div class="sim-report-inner">
        <h2>Simulation Report</h2>
        <div class="sim-cards">
          <div class="sim-card">
            <div class="val">${stats.duration.toFixed(0)}s</div>
            <div class="label">Duration</div>
          </div>
          <div class="sim-card">
            <div class="val">${stats.deaths}/${stats.totalAgents}</div>
            <div class="label">Deaths</div>
          </div>
          <div class="sim-card">
            <div class="val">${(stats.survivalRate * 100).toFixed(0)}%</div>
            <div class="label">Survival Rate</div>
          </div>
          <div class="sim-card">
            <div class="val">${stats.timeToFirstDeath !== null ? stats.timeToFirstDeath.toFixed(0) + "s" : "-"}</div>
            <div class="label">First Death</div>
          </div>
          <div class="sim-card">
            <div class="val">${stats.avgSurvivalTime.toFixed(0)}s</div>
            <div class="label">Avg Survival</div>
          </div>
        </div>
        <table class="sim-table">
          <thead><tr><th>Agent</th><th>Status</th><th>Time of Death</th><th>Cause</th><th>Damage</th></tr></thead>
          <tbody>${agentRows}</tbody>
        </table>
        <div class="sim-heatmap-btns">
          <button data-layer="movement">Movement</button>
          <button data-layer="damage">Damage Taken</button>
          <button data-layer="deaths">Deaths</button>
          <button data-layer="hide">Hide Heatmap</button>
        </div>
        <button class="sim-show-report-btn">Show Full Report</button>
        <button class="sim-close-btn">Close Report</button>
      </div>
    `;

    const setHeatmapMode = (active: boolean) => {
      if (active) {
        this.container.classList.add("heatmap-active");
      } else {
        this.container.classList.remove("heatmap-active");
      }
    };

    // Wire heatmap buttons
    const btns = this.container.querySelectorAll<HTMLButtonElement>(".sim-heatmap-btns button");
    btns.forEach((btn) => {
      btn.addEventListener("click", () => {
        btns.forEach((b) => b.classList.remove("active"));
        const layer = btn.dataset.layer;
        if (layer === "movement") {
          btn.classList.add("active");
          heatmapOverlay.setData(stats.movementGrid, stats.gridWidth, stats.gridHeight);
          heatmapOverlay.setVisible(true);
          setHeatmapMode(true);
        } else if (layer === "damage") {
          btn.classList.add("active");
          heatmapOverlay.setData(stats.damageGrid, stats.gridWidth, stats.gridHeight);
          heatmapOverlay.setVisible(true);
          setHeatmapMode(true);
        } else if (layer === "deaths") {
          btn.classList.add("active");
          heatmapOverlay.setData(stats.deathGrid, stats.gridWidth, stats.gridHeight);
          heatmapOverlay.setVisible(true);
          setHeatmapMode(true);
        } else {
          heatmapOverlay.setVisible(false);
          setHeatmapMode(false);
        }
      });
    });

    // Wire "Show Full Report" button (returns from heatmap mode)
    this.container.querySelector(".sim-show-report-btn")!.addEventListener("click", () => {
      setHeatmapMode(false);
      heatmapOverlay.setVisible(false);
      btns.forEach((b) => b.classList.remove("active"));
    });

    // Wire close button
    this.container.querySelector(".sim-close-btn")!.addEventListener("click", () => {
      this.hide();
      heatmapOverlay.setVisible(false);
    });

    this.container.style.display = "flex";
  }

  hide(): void {
    this.container.style.display = "none";
    this.container.classList.remove("heatmap-active");
  }

  dispose(): void {
    this.container.remove();
    this.style.remove();
  }
}
