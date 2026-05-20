from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render

from .forms import RegistrationForm

@login_required
def room_view(request):
    return render(request, 'room.html')


def register_view(request):
    if request.method == 'POST':
        form = RegistrationForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user)
            return redirect('room')
    else:
        form = RegistrationForm()

    return render(request, 'registration/register.html', {'form': form})
