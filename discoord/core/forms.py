from django import forms
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import User


class RegistrationForm(UserCreationForm):
    class Meta:
        model = User
        fields = ('username', 'password1', 'password2')

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['username'].widget = forms.TextInput(
            attrs={'placeholder': 'Username', 'autocomplete': 'username'}
        )
        self.fields['password1'].widget = forms.PasswordInput(
            attrs={'placeholder': 'Password', 'autocomplete': 'new-password'}
        )
        self.fields['password2'].widget = forms.PasswordInput(
            attrs={'placeholder': 'Confirm password', 'autocomplete': 'new-password'}
        )
