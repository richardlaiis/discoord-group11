from django.shortcuts import render

def room_view(request):
    return render(request, 'room.html')
