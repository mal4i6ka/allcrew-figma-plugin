from django.shortcuts import render


def index(request):
    context = {
        'title': 'Card title',
        'visible': True,
    }
    return render(request, 'pages/index.html', context)
