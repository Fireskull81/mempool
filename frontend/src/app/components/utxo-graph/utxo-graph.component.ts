import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, NgZone, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { EChartsOption } from '../../graphs/echarts';
import { BehaviorSubject, Subscription } from 'rxjs';
import { Utxo } from '../../interfaces/electrs.interface';
import { StateService } from '../../services/state.service';
import { Router } from '@angular/router';
import { RelativeUrlPipe } from '../../shared/pipes/relative-url/relative-url.pipe';
import { renderSats } from '../../shared/common.utils';

@Component({
  selector: 'app-utxo-graph',
  templateUrl: './utxo-graph.component.html',
  styleUrls: ['./utxo-graph.component.scss'],
  styles: [`
    .loadingGraphs {
      position: absolute;
      top: 50%;
      left: calc(50% - 15px);
      z-index: 99;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UtxoGraphComponent implements OnChanges, OnDestroy {
  @Input() utxos: Utxo[];
  @Input() height: number = 200;
  @Input() right: number | string = 10;
  @Input() left: number | string = 70;
  @Input() widget: boolean = false;

  subscription: Subscription;
  redraw$: BehaviorSubject<boolean> = new BehaviorSubject(false);

  chartOptions: EChartsOption = {};
  chartInitOptions = {
    renderer: 'svg',
  };

  error: any;
  isLoading = true;
  chartInstance: any = undefined;

  constructor(
    public stateService: StateService,
    private cd: ChangeDetectorRef,
    private zone: NgZone,
    private router: Router,
    private relativeUrlPipe: RelativeUrlPipe,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    this.isLoading = true;
    if (!this.utxos) {
      return;
    }
    if (changes.utxos) {
      this.prepareChartOptions(this.utxos);
    }
  }

  prepareChartOptions(utxos: Utxo[]) {
    if (!utxos || utxos.length === 0) {
      return;
    }

    this.isLoading = false;

    // Helper functions
    const distance = (x1: number, y1: number, x2: number, y2: number): number => Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    const intersectionPoints = (x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): [number, number][] => {
      const d = distance(x1, y1, x2, y2);
      const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
      const h = Math.sqrt(r1 * r1 - a * a);
      const x3 = x1 + a * (x2 - x1) / d;
      const y3 = y1 + a * (y2 - y1) / d;
      return [
        [x3 + h * (y2 - y1) / d, y3 - h * (x2 - x1) / d],
        [x3 - h * (y2 - y1) / d, y3 + h * (x2 - x1) / d]
      ];
    };

    // Naive algorithm to pack circles as tightly as possible without overlaps
    const placedCircles: { x: number, y: number, r: number, utxo: Utxo, distances: number[] }[] = [];
    // Pack in descending order of value, and limit to the top 500 to preserve performance
    const sortedUtxos = utxos.sort((a, b) => b.value - a.value).slice(0, 500);
    let centerOfMass = { x: 0, y: 0 };
    let weightOfMass = 0;
    sortedUtxos.forEach((utxo, index) => {
      // area proportional to value
      const r = Math.sqrt(utxo.value);

      // special cases for the first two utxos
      if (index === 0) {
        placedCircles.push({ x: 0, y: 0, r, utxo, distances: [0] });
        return;
      }
      if (index === 1) {
        const c = placedCircles[0];
        placedCircles.push({ x: c.r + r, y: 0, r, utxo, distances: [c.r + r, 0] });
        c.distances.push(c.r + r);
        return;
      }

      // The best position will be touching two other circles
      // generate a list of candidate points by finding all such positions
      // where the circle can be placed without overlapping other circles
      const candidates: [number, number, number[]][] = [];
      const numCircles = placedCircles.length;
      for (let i = 0; i < numCircles; i++) {
        for (let j = i + 1; j < numCircles; j++) {
          const c1 = placedCircles[i];
          const c2 = placedCircles[j];
          if (c1.distances[j] > (c1.r + c2.r + r + r)) {
            // too far apart for new circle to touch both
            continue;
          }
          const points = intersectionPoints(c1.x, c1.y, c1.r + r, c2.x, c2.y, c2.r + r);
          points.forEach(([x, y]) => {
            const distances: number[] = [];
            let valid = true;
            for (let k = 0; k < numCircles; k++) {
              const c = placedCircles[k];
              const d = distance(x, y, c.x, c.y);
              if (k !== i && k !== j && d < (r + c.r)) {
                valid = false;
                break;
              } else {
                distances.push(d);
              }
            }
            if (valid) {
              candidates.push([x, y, distances]);
            }
          });
        }
      }

      // Pick the candidate closest to the center of mass
      const [x, y, distances] = candidates.length ? candidates.reduce((closest, candidate) =>
        distance(candidate[0], candidate[1], centerOfMass[0], centerOfMass[1]) <
        distance(closest[0], closest[1], centerOfMass[0], centerOfMass[1])
          ? candidate
          : closest
      ) : [0, 0, []];

      placedCircles.push({ x, y, r, utxo, distances });
      for (let i = 0; i < distances.length; i++) {
        placedCircles[i].distances.push(distances[i]);
      }
      distances.push(0);

      // Update center of mass
      centerOfMass = {
        x: (centerOfMass.x * weightOfMass + x) / (weightOfMass + r),
        y: (centerOfMass.y * weightOfMass + y) / (weightOfMass + r),
      };
      weightOfMass += r;
    });

    // Precompute the bounding box of the graph
    const minX = Math.min(...placedCircles.map(d => d.x - d.r));
    const maxX = Math.max(...placedCircles.map(d => d.x + d.r));
    const minY = Math.min(...placedCircles.map(d => d.y - d.r));
    const maxY = Math.max(...placedCircles.map(d => d.y + d.r));
    const width = maxX - minX;
    const height = maxY - minY;

    const data = placedCircles.map((circle, index) => [
      circle.utxo,
      index,
      circle.x,
      circle.y,
      circle.r
    ]);

    this.chartOptions = {
      series: [{
        type: 'custom',
        coordinateSystem: undefined,
        data,
        renderItem: (params, api) => {
          const idx = params.dataIndex;
          const datum = data[idx];
          const utxo = datum[0] as Utxo;
          const chartWidth = api.getWidth();
          const chartHeight = api.getHeight();
          const scale = Math.min(chartWidth / width, chartHeight / height);
          const scaledWidth = width * scale;
          const scaledHeight = height * scale;
          const offsetX = (chartWidth - scaledWidth) / 2 - minX * scale;
          const offsetY = (chartHeight - scaledHeight) / 2 - minY * scale;
          const x = datum[2] as number;
          const y = datum[3] as number;
          const r = datum[4] as number;
          if (r * scale < 3) {
            // skip items too small to render cleanly
            return;
          }
          const valueStr = renderSats(utxo.value, this.stateService.network);
          const elements: any[] = [
            {
              type: 'circle',
              autoBatch: true,
              shape: {
                cx: (x * scale) + offsetX,
                cy: (y * scale) + offsetY,
                r: (r * scale) - 1,
              },
              style: {
                fill: '#5470c6',
              }
            },
          ];
          const labelFontSize = Math.min(36, r * scale * 0.25);
          if (labelFontSize > 8) {
            elements.push({
              type: 'text',
              x: (x * scale) + offsetX,
              y: (y * scale) + offsetY,
              style: {
                text: valueStr,
                fontSize: labelFontSize,
                fill: '#fff',
                align: 'center',
                verticalAlign: 'middle',
              },
            });
          }
          return {
            type: 'group',
            children: elements,
          };
        }
      }],
      tooltip: {
        backgroundColor: 'rgba(17, 19, 31, 1)',
        borderRadius: 4,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        textStyle: {
          color: 'var(--tooltip-grey)',
          align: 'left',
        },
        borderColor: '#000',
        formatter: (params: any): string => {
          const utxo = params.data[0] as Utxo;
          const valueStr = renderSats(utxo.value, this.stateService.network);
          return `
          <b style="color: white;">${utxo.txid.slice(0, 6)}...${utxo.txid.slice(-6)}:${utxo.vout}</b>
          <br>
          ${valueStr}`;
        },
      }
    };

    this.cd.markForCheck();
  }

  onChartClick(e): void {
    if (e.data?.[0]?.txid) {
      this.zone.run(() => {
        const url = this.relativeUrlPipe.transform(`/tx/${e.data[0].txid}`);
        if (e.event.event.shiftKey || e.event.event.ctrlKey || e.event.event.metaKey) {
          window.open(url + '?mode=details#vout=' + e.data[0].vout);
        } else {
          this.router.navigate([url], { fragment: `vout=${e.data[0].vout}` });
        }
      });
    }
  }

  onChartInit(ec): void {
    this.chartInstance = ec;
    this.chartInstance.on('click', 'series', this.onChartClick.bind(this));
  }

  ngOnDestroy(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
  }

  isMobile(): boolean {
    return (window.innerWidth <= 767.98);
  }
}
