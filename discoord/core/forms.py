from django import forms
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import User

from .models import ChatGroup


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


class ChatGroupCreateForm(forms.ModelForm):
    class Meta:
        model = ChatGroup
        fields = ('name',)
        widgets = {
            'name': forms.TextInput(
                attrs={'placeholder': 'Create a new group', 'autocomplete': 'off'}
            ),
        }


class ChatGroupJoinForm(forms.Form):
    invite_code = forms.CharField(
        max_length=12,
        widget=forms.TextInput(
            attrs={'placeholder': 'Enter invite code or slug', 'autocomplete': 'off'}
        ),
    )


class ChatMessageForm(forms.Form):
    content = forms.CharField(
        max_length=1000,
        widget=forms.TextInput(attrs={'placeholder': 'Message this group...', 'autocomplete': 'off'}),
    )


class BlackboardNoteForm(forms.Form):
    content = forms.CharField(
        max_length=1000,
        widget=forms.Textarea(
            attrs={
                'placeholder': 'Write a new note...',
                'rows': 3,
                'autocomplete': 'off',
                'class': 'blackboard-input',
            }
        ),
    )
