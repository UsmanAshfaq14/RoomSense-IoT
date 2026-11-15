import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, User, errorText, fmtAgo } from './api.service';

@Component({
  selector: 'app-people',
  imports: [FormsModule],
  template: `
    <section class="page-head">
      <h1>People and badges</h1>
      <p class="sub">Badges are stored only as a fingerprint (SHA-256), never as the number on the card.</p>
    </section>
    @if (notice()) { <div class="toast" role="status"><span>{{ notice() }}</span><button type="button" class="close" (click)="notice.set('')" aria-label="Close message">×</button></div> }

    <div class="two-col">
      <section class="card">
        <div class="card-head"><h2>Register a badge</h2>
          <p class="hint">Tap the new badge on the reader. It is refused once, then appears here.</p></div>
        <div class="badge-wait" [class.found]="!!form.rfidUid">
          @if (form.rfidUid) {
            Badge <b class="mono">{{ form.rfidUid }}</b>@if (seenAt()) { <span> · tapped {{ seenAt() }}</span> }
          } @else {
            Waiting for a badge on the reader…
          }
        </div>
        <p class="form-note">Fields marked <span class="req" aria-hidden="true">*</span><span class="sr-only">with a star</span> are required.</p>
        <form class="stack" (ngSubmit)="register()">
          <label><span>Badge number <span class="req" aria-hidden="true">*</span><span class="hint"> (10 characters, 0-9 and A-F)</span></span>
            <input name="uid" [(ngModel)]="form.rfidUid" class="mono" maxlength="10" placeholder="e.g. 5900BF16C7" required
                   [attr.aria-invalid]="invalid() === 'uid' || null" [attr.aria-describedby]="invalid() === 'uid' ? 'reg-error' : null"></label>
          <label><span>Name <span class="req" aria-hidden="true">*</span></span>
            <input name="name" [(ngModel)]="form.name" required
                   [attr.aria-invalid]="invalid() === 'name' || null" [attr.aria-describedby]="invalid() === 'name' ? 'reg-error' : null"></label>
          <label>Email <input name="email" type="email" [(ngModel)]="form.email" placeholder="optional"
                   [attr.aria-invalid]="invalid() === 'email' || null" [attr.aria-describedby]="invalid() === 'email' ? 'reg-error' : null"></label>
          <label>Role
            <select name="role" [(ngModel)]="form.role">
              <option value="student">Student: books and checks in</option>
              <option value="admin">Admin: may enter any room</option>
            </select>
          </label>
          <button type="submit" class="primary">Register badge</button>
        </form>
        @if (formError()) { <p class="field-error" id="reg-error" role="alert">{{ formError() }}</p> }
      </section>

      <section class="card">
        <div class="card-head"><h2>Registered people</h2></div>
        @if (error()) { <p class="banner error" role="alert">{{ error() }}</p> }
        <ul class="list">
          @for (u of users(); track u._id) {
            <li><span class="what">{{ u.name }}</span><span class="when">{{ u.email || '' }}</span>
              <span class="chip small" [class.ok]="u.role === 'admin'">{{ u.role }}</span></li>
          } @empty { <li class="empty">Nobody yet.</li> }
        </ul>
      </section>
    </div>
  `
})
export class PeopleComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private poll?: ReturnType<typeof setInterval>;
  readonly users = signal<User[]>([]);
  readonly error = signal('');
  readonly notice = signal('');
  readonly seenAt = signal('');
  readonly formError = signal('');
  readonly invalid = signal('');
  form = { rfidUid: '', name: '', email: '', role: 'student' };
  private lastSeenUid = '';

  ngOnInit() {
    this.load();
    // Light polling, only while this page is open: the badge reader has no other way to reach the form.
    this.poll = setInterval(() => this.checkBadge(), 2000);
  }
  ngOnDestroy() { clearInterval(this.poll); }

  private async load() {
    try { this.users.set(await this.api.users()); this.error.set(''); } catch (err) { this.error.set(errorText(err)); }
  }
  private async checkBadge() {
    try {
      const b = await this.api.lastUnknownBadge();
      if (b && b.uid !== this.lastSeenUid) { this.lastSeenUid = b.uid; this.form.rfidUid = b.uid; }
      this.seenAt.set(b ? fmtAgo(b.at) : '');
    } catch { /* server down: the list shows the error */ }
  }
  async register() {
    const uid = this.form.rfidUid.trim().toUpperCase();
    this.formError.set(''); this.invalid.set('');
    if (!/^[0-9A-F]{10}$/.test(uid)) { this.formError.set('The badge number must be 10 characters, digits 0-9 and letters A-F: tap the badge on the reader to fill it in.'); this.invalid.set('uid'); return; }
    if (!this.form.name.trim()) { this.formError.set('Enter the person\'s name.'); this.invalid.set('name'); return; }
    try {
      const u = await this.api.register({ name: this.form.name.trim(), email: this.form.email.trim() || undefined, role: this.form.role, rfidUid: uid });
      this.notice.set(`${u.name} registered. Tap the badge again to check in.`);
      this.form = { rfidUid: '', name: '', email: '', role: 'student' };
      this.load();
    } catch (err) {
      const text = errorText(err);
      this.formError.set(text);
      this.invalid.set(/badge|uid/i.test(text) ? 'uid' : /email/i.test(text) ? 'email' : /name/i.test(text) ? 'name' : '');
    }
  }
}
