import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HelpTip } from './help-tip';

describe('HelpTip', () => {
  let component: HelpTip;
  let fixture: ComponentFixture<HelpTip>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HelpTip],
    }).compileComponents();

    fixture = TestBed.createComponent(HelpTip);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('heading', 'Release');
    fixture.componentRef.setInput('body', 'Ship a version from this repo.');
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('labels the button from the heading', () => {
    const btn = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('About Release');
  });

  it('opens on click', () => {
    const btn = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    btn.click();
    fixture.detectChanges();
    expect(component.open()).toBeTrue();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });
});
