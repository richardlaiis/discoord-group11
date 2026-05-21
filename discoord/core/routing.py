from django.urls import path

from .consumers import ChatConsumer

websocket_urlpatterns = [
    path('ws/chat/<slug:group_slug>/', ChatConsumer.as_asgi()),
]