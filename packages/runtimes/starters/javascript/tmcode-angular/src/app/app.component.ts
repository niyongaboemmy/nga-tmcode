import { Component, computed, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [FormsModule],
  template: `
    <main>
      <h1>Hello, Angular</h1>
      <form (ngSubmit)="add()">
        <input [(ngModel)]="text" name="text" placeholder="New task" />
        <button>Add</button>
      </form>
      <ul>
        @for (task of tasks(); track $index) {
          <li>{{ task }}</li>
        }
      </ul>
      <p>{{ count() }} tasks</p>
    </main>
  `,
})
export class AppComponent {
  text = "";
  tasks = signal<string[]>(["Learn Angular"]);
  count = computed(() => this.tasks().length);

  add() {
    if (!this.text.trim()) return;
    this.tasks.update((t) => [...t, this.text.trim()]);
    this.text = "";
  }
}
