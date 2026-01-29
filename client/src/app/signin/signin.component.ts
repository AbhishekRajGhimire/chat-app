import { Component, OnInit } from '@angular/core';
import { FormGroup, FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-signin',
  templateUrl: './signin.component.html',
  styleUrls: ['./signin.component.scss'],
})
export class SigninComponent implements OnInit {
  username: string = '';
  password: string = '';
  signInForm!: FormGroup;

  constructor(
    private formBuilder: FormBuilder,
    private authService: AuthService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.signInForm = this.formBuilder.group({
      username: ['', Validators.required],
      password: ['', Validators.required],
    });
  }

  onSubmit() {
    if (this.signInForm.invalid) {
      return;
    }

    const username = this.signInForm.get('username')?.value;
    const password = this.signInForm.get('password')?.value;

    this.authService.signin(username, password).subscribe(
      (response) => {
        // Assuming the API response contains an 'access_token' field
        const token = response.access_token;
        if (token) {
          localStorage.setItem('access_token', token);
          localStorage.setItem('username', response.username);
          window.alert("Successfully logged in")
          this.router.navigate(['/']); // Navigate to the chat section on successful login
        } else {
          console.error('Sign-in failed');
        }
      },
      (error) => {
        window.alert('Error during sign-in:' + error.error.error);
      }
    );
  }
}