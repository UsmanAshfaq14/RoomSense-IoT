import { Component, ElementRef, OnDestroy, computed, effect, input, viewChild } from '@angular/core';
import {
  BarController, BarElement, CategoryScale, Chart, ChartConfiguration, Filler, Legend, LineController, LineElement,
  LinearScale, PointElement, Tooltip
} from 'chart.js';

// Only the parts these charts use: a smaller download than registering all of Chart.js.
Chart.register(LineController, LineElement, PointElement, BarController, BarElement, LinearScale, CategoryScale, Filler, Legend, Tooltip);

export interface Series { label: string; points: { x: number; y: number }[]; color: string; axis?: 'y' | 'y2'; stepped?: boolean; fill?: boolean }
export interface Bars { labels: string[]; sets: { label: string; values: number[]; color: string }[] }

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let chartCount = 0;
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

// A thin wrapper around Chart.js: line charts over time (x = epoch ms) or grouped bars.
@Component({
  selector: 'app-chart',
  // The canvas is a picture: its label says what it shows, and a text version of the data (min, max, latest per
  // line; the values per bar) is linked to it for screen readers (RGAA 1.3 and 1.6).
  template: `<div class="chart-box" [style.height.px]="height()"><canvas #canvas role="img" [attr.aria-label]="label()" [attr.aria-describedby]="descId"></canvas></div>
    <p class="sr-only" [id]="descId">{{ summary() }}</p>`,
  styles: [`.chart-box { position: relative; width: 100%; }`]
})
export class ChartComponent implements OnDestroy {
  readonly series = input<Series[]>([]);
  readonly bars = input<Bars | null>(null);
  readonly yLabel = input('');
  readonly y2Label = input('');
  readonly label = input('chart');
  readonly height = input(240);
  readonly descId = `chart-desc-${++chartCount}`;
  readonly summary = computed(() => {
    const bars = this.bars();
    const round = (n: number) => Math.round(n * 10) / 10;
    if (bars) {
      return bars.sets.map((set) => `${set.label}: ` + bars.labels.map((l, i) => `${l} ${round(set.values[i])}`).join(', ')).join('. ') || 'No data yet.';
    }
    const lines = this.series().filter((s) => s.points.length);
    if (!lines.length) return 'No data in this period.';
    return lines.map((s) => {
      const ys = s.points.map((p) => p.y);
      const lastPt = s.points[s.points.length - 1];
      return `${s.label}: from ${round(Math.min(...ys))} to ${round(Math.max(...ys))}, latest ${round(lastPt.y)} at ${hhmm(lastPt.x)}`;
    }).join('. ') + '.';
  });
  private canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private chart?: Chart;

  constructor() {
    effect(() => this.render(this.series(), this.bars()));
  }

  private render(series: Series[], bars: Bars | null) {
    this.chart?.destroy();
    const grid = css('--grid') || '#ddd';
    const ink = css('--muted') || '#666';
    const common = {
      responsive: true, maintainAspectRatio: false, animation: false as const,
      plugins: { legend: { labels: { color: ink, boxWidth: 12 } }, tooltip: { intersect: false, mode: 'index' as const } }
    };
    let config: ChartConfiguration;
    if (bars) {
      config = {
        type: 'bar',
        data: { labels: bars.labels, datasets: bars.sets.map((s) => ({ label: s.label, data: s.values, backgroundColor: s.color, borderRadius: 3 })) },
        options: { ...common, scales: { x: { grid: { display: false }, ticks: { color: ink } }, y: { beginAtZero: true, grid: { color: grid }, ticks: { color: ink }, title: { display: !!this.yLabel(), text: this.yLabel(), color: ink } } } }
      };
    } else {
      const hasY2 = series.some((s) => s.axis === 'y2');
      config = {
        type: 'line',
        data: {
          datasets: series.map((s) => ({
            label: s.label, data: s.points, borderColor: s.color, backgroundColor: s.color + '22', yAxisID: s.axis || 'y',
            stepped: s.stepped ? ('before' as const) : false, fill: !!s.fill, pointRadius: 0, borderWidth: 2, tension: s.stepped ? 0 : 0.25
          }))
        },
        options: {
          ...common, parsing: false,
          scales: {
            x: { type: 'linear', grid: { color: grid }, ticks: { color: ink, maxTicksLimit: 8, callback: (v) => hhmm(Number(v)) } },
            y: { grid: { color: grid }, ticks: { color: ink }, title: { display: !!this.yLabel(), text: this.yLabel(), color: ink } },
            ...(hasY2 ? { y2: { position: 'right' as const, grid: { display: false }, ticks: { color: ink }, title: { display: !!this.y2Label(), text: this.y2Label(), color: ink } } } : {})
          }
        }
      };
    }
    this.chart = new Chart(this.canvas().nativeElement, config);
  }

  ngOnDestroy() { this.chart?.destroy(); }
}
