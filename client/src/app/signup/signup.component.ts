import { Component } from '@angular/core';
import { FormGroup, FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-signup',
  templateUrl: './signup.component.html',
  styleUrls: ['./signup.component.scss'],
})
export class SignupComponent {
  username: string = '';
  password: string = '';
  signUpForm!: FormGroup;

  constructor(
    private formBuilder: FormBuilder,
    private authService: AuthService,
    private router: Router
  ) {}   

  ngOnInit(): void {
    this.signUpForm = this.formBuilder.group({
      username: ['', Validators.required],
      password: ['', Validators.required]
    });
  }

  onSubmit() {
    if (this.signUpForm.invalid) {
      return;
    }
    const username = this.signUpForm.get('username')?.value;
    const password = this.signUpForm.get('password')?.value;

    this.authService.signup(username, password).subscribe(
      response => {
        // Registration success
        window.alert('Registration successful');
        this.router.navigate(["/signin"]);            
      },
      error => {
        // Registration failed
        window.alert(error.error)
        }
    );
  }
}