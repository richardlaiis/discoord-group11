from django.contrib.auth import views as auth_views
from django.urls import path
from . import views

urlpatterns = [
    path('groups/create/', views.create_group_view, name='create_group'),
    path('groups/join/', views.join_group_view, name='join_group'),
    path('groups/<slug:slug>/messages/', views.send_message_view, name='send_message'),
    path('groups/<slug:slug>/move/', views.move_member_view, name='move_member'),
    path('groups/<slug:slug>/state/', views.room_state_view, name='room_state'),
    path('groups/<slug:slug>/messages/fragment/', views.group_messages_fragment, name='group_messages_fragment'),
    path('groups/<slug:slug>/', views.room_view, name='room_group'),
    path('', views.room_view, name='room'),
    path('login/', auth_views.LoginView.as_view(template_name='registration/login.html'), name='login'),
    path('logout/', auth_views.LogoutView.as_view(), name='logout'),
    path('register/', views.register_view, name='register'),
]
